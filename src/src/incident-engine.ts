// ============================================================
// Incident Engine — Build 1, Step 1 (spec Section 7)
// ============================================================
//
// HOW TO READ THIS FILE (for non-coders):
// Everything up to this point produces DEVICE-level conclusions: this
// switch is Critical, that one is Dependency. This file is the first
// piece that steps back and asks the bigger question: "what is the
// ONE operational problem here, and which device is actually to
// blame?" That's the difference between an engineer seeing one
// incident with a clear root cause, and seeing seven simultaneous red
// alerts with no story connecting them (spec 7.1, DP-003, DP-004).
//
// Like every other file in this build, this is a DELIBERATELY SIMPLE
// first version. It proves the core idea - "group related device
// transitions into one incident, track its lifecycle over time,
// don't close it the instant things look better" - end to end. It
// does NOT yet implement:
//   - Re-ranking the "most probable root cause" as new evidence comes
//     in (7.4 calls this a "living conclusion"). This version fixes
//     the root cause as whichever device the incident started with,
//     and never reconsiders it. Real re-ranking needs timing/evidence
//     correlation - the same gap dependency-evaluator.ts already
//     flagged as Incident Engine territory. This is that territory,
//     just not built yet.
//   - Incident-level confidence (7.4 says this is separate from any
//     one device's confidence) and incident priority (7.6, which
//     needs operational_role, redundancy and business-impact data
//     this build doesn't model yet).
//   - Manual interaction (7.9: acknowledge, annotate, suppress, place
//     in maintenance) - there's no UI or API for any of this yet, so
//     there's nothing here to guard IE-008 against. Worth remembering
//     when that's built: acknowledgement must never be allowed to
//     touch evidence or calculated state, only sit alongside it.
//   - RackWatch appliance incidents (7.7) - this file only reasons
//     about customer infrastructure, never appliance health.
//
// Confirmed with the person building this (not guessed): once every
// device in an incident reads Healthy again, RackWatch waits 2
// consecutive healthy poll cycles before closing the incident (7.8,
// IE-006, IE-007) - a stability buffer ON TOP OF each device's own
// individual recovery threshold, not a replacement for it.
// ============================================================

import { randomUUID } from "crypto";
import type {
  DeviceStateRecord,
  StateTransitionEvent,
  IncidentLifecycleStage,
} from "./domain-model";

// ---- Configuration (spec 7.8, IE-006, IE-007) ----

export interface IncidentEngineConfig {
  resolve_after_consecutive_healthy_cycles: number;
}

export const DEFAULT_INCIDENT_ENGINE_CONFIG: IncidentEngineConfig = {
  resolve_after_consecutive_healthy_cycles: 2,
};

// ---- The Incident shape ----
// This extends spec 8.2's IncidentStub (domain-model.ts) with the
// extra bookkeeping this engine actually needs - a timeline (IE-004)
// and a recovery-stability counter. The core fields (incident_id,
// lifecycle_stage, affected_device_ids, most_probable_root_cause,
// created_at) stay wire-compatible with IncidentStub so a future API
// layer can expose either.

export interface IncidentTimelineEntry {
  timestamp: string;
  description: string; // human-readable, e.g. "core-switch-a transitioned to Critical: ..."
  device_id?: string;
  event_id?: string; // links back to the StateTransitionEvent that caused this entry, if any
}

export interface Incident {
  incident_id: string;
  lifecycle_stage: IncidentLifecycleStage;
  affected_device_ids: string[];
  most_probable_root_cause?: string; // device_id - fixed at creation in this version, see file header
  created_at: string;
  timeline: IncidentTimelineEntry[]; // IE-004: append-only. IE-005: never rewritten once Resolved.
  consecutive_healthy_cycles: number; // internal - counts toward the closure threshold above
}

// ---- What this engine needs, and what it hands back ----
// Expected to run ONCE PER POLL CYCLE, after the dependency evaluator
// has produced this cycle's DISPLAYED states and transition events -
// the same outputs dependency-evaluator.ts already produces.

export interface IncidentEvaluationInput {
  states: Map<string, DeviceStateRecord>; // this cycle's displayed states, keyed by device_id
  transitionEvents: Map<string, StateTransitionEvent>; // this cycle's transitions, if any, keyed by device_id
  openIncidents: Incident[]; // every incident carried over from last cycle that isn't yet Resolved
}

export interface IncidentEvaluationResult {
  incidents: Incident[]; // the full updated set - open incidents plus any newly Resolved this cycle
}

// ---- The main pass ----

export function evaluateIncidents(
  input: IncidentEvaluationInput,
  now: string, // ISO-8601 timestamp for this poll cycle - threaded through explicitly rather than
               // read from the system clock inside the function, so results stay reproducible (1.1)
  config: IncidentEngineConfig = DEFAULT_INCIDENT_ENGINE_CONFIG
): IncidentEvaluationResult {
  // Work on copies so we never mutate the caller's previous-cycle data.
  const incidents = input.openIncidents.map((incident) => ({
    ...incident,
    affected_device_ids: [...incident.affected_device_ids],
    timeline: [...incident.timeline],
  }));

  // Snapshot membership counts BEFORE this cycle's changes, so we can
  // tell afterwards which incidents actually gained a new member this
  // cycle (that's what separates "Correlating" from "Active" below).
  const priorMemberCounts = new Map(incidents.map((i) => [i.incident_id, i.affected_device_ids.length]));
  const newlyCreatedThisCycle = new Set<string>();

  // ---- Step 1: fold this cycle's transitions into incidents ----
  // IE-001/IE-002/IE-003: a related transition joins an existing
  // incident instead of spawning a duplicate one.
  for (const [deviceId, event] of input.transitionEvents) {
    if (event.to_state === "Healthy" || event.to_state === "Unknown") {
      // Recoveries and Unknowns don't create or independently join an
      // incident here - recovery is handled by progressLifecycle below,
      // and Unknown is neither confirmed trouble nor confirmed health
      // (SE-001, 5.2), so it shouldn't trigger new incident creation.
      continue;
    }

    if (event.to_state === "Dependency") {
      const upstreamId = input.states.get(deviceId)?.explanation?.dependency_ref;
      if (!upstreamId) continue; // shouldn't happen, but never crash on missing data

      const owning = findIncidentContainingDevice(incidents, upstreamId);
      if (owning) {
        addDeviceToIncident(owning, deviceId, event, now);
      } else {
        // Upstream's own Critical transition hasn't been processed yet
        // this cycle (map iteration order isn't guaranteed) - create a
        // placeholder incident rooted at the upstream now. When the
        // upstream's own transition is processed later in this same
        // loop, it will find and join this incident rather than
        // duplicating it (see findIncidentContainingDevice below).
        const created = createIncident(upstreamId, deviceId, event, now);
        incidents.push(created);
        newlyCreatedThisCycle.add(created.incident_id);
      }
      continue;
    }

    if (event.to_state === "Critical" || event.to_state === "Degraded") {
      // Degraded takes the same join-or-create path as Critical - the
      // difference between them is a device-state threshold
      // (state-engine.ts), not whether it's worth correlating into an
      // incident. Without this branch, a Degraded transition matched
      // none of the cases above and fell through untouched: no
      // incident, no timeline entry, no visibility.
      const owning = findIncidentContainingDevice(incidents, deviceId);
      if (owning) {
        // Same device re-entering Critical/Degraded inside an incident
        // that hadn't fully closed (e.g. it was Recovering) - re-attach
        // rather than opening a duplicate (IE-001, IE-003).
        addDeviceToIncident(owning, deviceId, event, now);
        owning.consecutive_healthy_cycles = 0;
      } else {
        const created = createIncident(deviceId, deviceId, event, now);
        incidents.push(created);
        newlyCreatedThisCycle.add(created.incident_id);
      }
    }
  }

  // ---- Step 2: progress each incident's lifecycle stage ----
  // A brand-new incident stays "Detected" for exactly the cycle it was
  // created in - it only starts advancing from the NEXT cycle onward.
  for (const incident of incidents) {
    if (incident.lifecycle_stage === "Resolved") continue; // IE-005: immutable once resolved
    if (newlyCreatedThisCycle.has(incident.incident_id)) continue;

    const priorCount = priorMemberCounts.get(incident.incident_id) ?? incident.affected_device_ids.length;
    const gainedMembersThisCycle = incident.affected_device_ids.length > priorCount;
    progressLifecycle(incident, input.states, config, now, gainedMembersThisCycle);
  }

  return { incidents };
}

// ---- Find an existing, still-open incident this device already belongs to ----

function findIncidentContainingDevice(incidents: Incident[], deviceId: string): Incident | undefined {
  return incidents.find(
    (incident) =>
      incident.lifecycle_stage !== "Resolved" &&
      (incident.most_probable_root_cause === deviceId || incident.affected_device_ids.includes(deviceId))
  );
}

// ---- Create a brand-new incident, rooted at a given device ----

function createIncident(
  rootCauseDeviceId: string,
  firstAffectedDeviceId: string,
  event: StateTransitionEvent,
  now: string
): Incident {
  const affected = Array.from(new Set([rootCauseDeviceId, firstAffectedDeviceId]));
  return {
    incident_id: randomUUID(),
    lifecycle_stage: "Detected",
    affected_device_ids: affected,
    most_probable_root_cause: rootCauseDeviceId,
    created_at: now,
    timeline: [
      {
        timestamp: now,
        description: `${firstAffectedDeviceId} transitioned to ${event.to_state}: ${event.reason}`,
        device_id: firstAffectedDeviceId,
        event_id: event.event_id,
      },
    ],
    consecutive_healthy_cycles: 0,
  };
}

// ---- Add a device to an existing incident, recording why (IE-004) ----

function addDeviceToIncident(
  incident: Incident,
  deviceId: string,
  event: StateTransitionEvent,
  now: string
): void {
  if (!incident.affected_device_ids.includes(deviceId)) {
    incident.affected_device_ids.push(deviceId);
  }
  incident.timeline.push({
    timestamp: now,
    description: `${deviceId} transitioned to ${event.to_state}: ${event.reason}`,
    device_id: deviceId,
    event_id: event.event_id,
  });
}

// ---- Step 2's actual lifecycle logic (spec 7.2, 7.8, IE-006, IE-007) ----
// Note: once an incident reaches Active, gaining yet another correlated
// member later does not revert it back to Correlating - Correlating is
// specifically the step right after an incident's founding cycle, not a
// state it can bounce back into repeatedly.

function progressLifecycle(
  incident: Incident,
  states: Map<string, DeviceStateRecord>,
  config: IncidentEngineConfig,
  now: string,
  gainedMembersThisCycle: boolean
): void {
  const memberStates = incident.affected_device_ids
    .map((id) => states.get(id))
    .filter((s): s is DeviceStateRecord => Boolean(s));

  const allMembersHealthy =
    memberStates.length > 0 && memberStates.every((s) => s.state === "Healthy");

  if (allMembersHealthy) {
    incident.consecutive_healthy_cycles += 1;

    if (incident.lifecycle_stage !== "Recovering") {
      incident.lifecycle_stage = "Recovering"; // IE-006: recovery doesn't instantly close the incident
      incident.timeline.push({
        timestamp: now,
        description: "All affected devices report Healthy - entering recovery stability window",
      });
    }

    if (incident.consecutive_healthy_cycles >= config.resolve_after_consecutive_healthy_cycles) {
      incident.lifecycle_stage = "Resolved";
      incident.timeline.push({
        timestamp: now,
        description: `Incident resolved after ${incident.consecutive_healthy_cycles} consecutive healthy cycles (IE-007)`,
      });
    }
    return;
  }

  // Not fully healthy yet this cycle - any partial recovery streak resets.
  incident.consecutive_healthy_cycles = 0;

  if (incident.lifecycle_stage === "Recovering") {
    // Regressed - something in the incident went bad again before the
    // stability window completed. Back to Active, not a fresh Detected.
    incident.lifecycle_stage = "Active";
    incident.timeline.push({
      timestamp: now,
      description: "Recovery interrupted before stability threshold was reached - incident remains Active",
    });
    return;
  }

  if (incident.lifecycle_stage === "Detected" || incident.lifecycle_stage === "Correlating") {
    incident.lifecycle_stage = gainedMembersThisCycle ? "Correlating" : "Active";
  }
  // Otherwise already Active - stays Active.
}

// ============================================================
// ILLUSTRATIVE ONLY - not executable, just here to make the shape
// concrete. Continuing the core-switch / access-switch example from
// dependency-evaluator.ts:
//
// Cycle 1: core-switch-a goes Critical (no dependents affected yet).
//   -> a new Incident is created, root cause = core-switch-a,
//      lifecycle_stage = "Detected".
//
// Cycle 2: access-switch-b (which depends on core-switch-a) is now
// recast as Dependency by dependency-evaluator.ts.
//   -> access-switch-b is correlated into the SAME incident rather
//      than opening a second one. Because membership just grew,
//      lifecycle_stage becomes "Correlating".
//
// Cycle 3: nothing new joins, core-switch-a is still down.
//   -> lifecycle_stage settles to "Active".
//
// Cycle 7: core-switch-a and access-switch-b both report Healthy.
//   -> lifecycle_stage becomes "Recovering".
//
// Cycle 8: still Healthy (2nd consecutive healthy cycle, per the
// confirmed default).
//   -> lifecycle_stage becomes "Resolved". Its timeline is now
//      considered immutable (IE-005) - any later correction would be
//      appended as a new revision, never rewritten in place.
// ============================================================
