// ============================================================
// Dependency Evaluator — Build 1 (spec 5.7)
// ============================================================
//
// HOW TO READ THIS FILE (for non-coders):
// The state-engine.ts files so far only ever look at ONE device at a
// time - they have no idea that Switch B plugs into Switch A. This
// file is the piece that finally looks across ALL devices together
// and asks: "is this device really broken, or is it just downstream
// of something else that's broken?"
//
// THE KEY IDEA, worth understanding even if you never read the code:
// Every device now effectively has TWO states:
//   - a RAW state - what the hysteresis engine concluded from that
//     device's own evidence alone (Healthy / Critical / Unknown)
//   - a DISPLAYED state - what actually shows on the dashboard, after
//     this file has had a chance to recast some Criticals as
//     Dependency
// Whatever component wires this up later must keep these separate.
// The RAW state is what gets fed back into evaluateDeviceState() as
// "previousState" next poll - never the displayed one. The hysteresis
// engine has no concept of "Dependency"; if a Dependency value ever
// leaked back in as its previous state, its escalate/recover logic
// would misbehave. This file only ever produces the DISPLAYED view.
//
// Still NOT implemented here (future steps / Incident Engine territory):
//   - Timing-based "independent fault" detection (5.7: "a downstream
//     device may later become Critical if independent evidence
//     demonstrates a separate fault"). This version has a simpler,
//     honest limitation: if a downstream device happens to fail for
//     its OWN unrelated reason at the exact same time its upstream is
//     also down, it will still show as Dependency, not Critical, until
//     the upstream recovers and the downstream's own problem re-emerges
//     on its own. Properly telling those two situations apart needs
//     evidence timing/correlation - that's Incident Engine reasoning
//     (7.4), not this file.
//   - Choosing between MULTIPLE simultaneous upstream causes for the
//     same device. If a device has two enabled dependencies and both
//     upstreams are down, whichever is found first wins. Ranking the
//     single "most probable root cause" among several candidates is
//     explicitly the Incident Engine's job (7.4), not this one.
// ============================================================

import type {
  DeviceStateRecord,
  DependencyRecord,
  StateTransitionEvent,
  StateExplanation,
} from "./domain-model";

// ---- What this function needs, and what it hands back ----
// Expected to be called ONCE PER POLL CYCLE, after the per-device
// hysteresis engine (state-engine.ts) has produced a raw state for
// every device - not once per single observation.

export interface DependencyEvaluationInput {
  states: Map<string, DeviceStateRecord>; // device_id -> that device's RAW state this cycle
  transitionEvents: Map<string, StateTransitionEvent>; // device_id -> this cycle's transition event, if any
  dependencies: DependencyRecord[]; // every configured dependency relationship, enabled or not
}

export interface DependencyEvaluationResult {
  states: Map<string, DeviceStateRecord>; // DISPLAYED states - what the dashboard should show
  transitionEvents: Map<string, StateTransitionEvent>; // updated so any recast to Dependency is reflected here too
}

// ---- The main pass ----

export function applyDependencyEvaluation(
  input: DependencyEvaluationInput
): DependencyEvaluationResult {
  const states = new Map(input.states);
  const transitionEvents = new Map(input.transitionEvents);

  // SE-007: only Configured or Verified dependencies drive automatic
  // Dependency state in Build 1. SE-008: Inferred relationships are
  // left out here entirely - they may support diagnostics elsewhere,
  // but must not silently become permanent topology by affecting
  // what's displayed.
  const eligibleDependencies = input.dependencies.filter(
    (dep) => dep.enabled && (dep.authority === "Configured" || dep.authority === "Verified")
  );

  // Dependency CHAINS (C depends on B depends on A) need more than one
  // sweep: if we check "C depends on B" before "B depends on A" has been
  // resolved, B still looks Critical (not yet recast to Dependency) and
  // C gets missed. So we keep re-checking until nothing changes anymore -
  // like letting dust settle. Capped defensively: a misconfigured cycle
  // should never be able to hang this in an infinite loop.
  let changed = true;
  let safetyCounter = 0;
  const maxIterations = eligibleDependencies.length + 1;

  while (changed && safetyCounter < maxIterations) {
    changed = false;
    safetyCounter++;

    for (const dep of eligibleDependencies) {
      const upstream = states.get(dep.upstream_device_id);
      const downstream = states.get(dep.downstream_device_id);
      if (!upstream || !downstream) continue; // no state on record for one side - can't reason about it yet

      // The upstream counts as "down" whether that's its own fault
      // (Critical) or already explained further up its own chain
      // (Dependency) - this is what makes multi-hop chains work.
      const upstreamIsDown = upstream.state === "Critical" || upstream.state === "Dependency";

      // Only a downstream device that is CURRENTLY Critical gets
      // reinterpreted. Healthy, Unknown, and already-Dependency states
      // are left exactly as they are (5.6).
      if (downstream.state === "Critical" && upstreamIsDown) {
        states.set(dep.downstream_device_id, recastStateAsDependency(downstream, dep.upstream_device_id));

        const existingEvent = transitionEvents.get(dep.downstream_device_id);
        if (existingEvent && existingEvent.to_state === "Critical") {
          transitionEvents.set(
            dep.downstream_device_id,
            recastTransitionEvent(existingEvent, dep.upstream_device_id)
          );
        }

        changed = true;
      }
    }
  }

  return { states, transitionEvents };
}

// ---- Recast one device's DISPLAYED state from Critical to Dependency ----
// Everything else about the record (confidence, since, etc.) is left as
// the raw engine computed it - this is a reinterpretation, not a new
// verdict from scratch. duration_seconds and confidence are therefore
// still whatever the raw Critical state already had (a known
// simplification - refining "how confident are we this is really just
// a dependency" is a reasonable later improvement, not done here).

function recastStateAsDependency(
  original: DeviceStateRecord,
  upstreamDeviceId: string
): DeviceStateRecord {
  const explanation: StateExplanation = original.explanation
    ? {
        ...original.explanation,
        conclusion: "Device appears unavailable because an upstream dependency has failed",
        dependency_ref: upstreamDeviceId,
      }
    : {
        conclusion: "Device appears unavailable because an upstream dependency has failed",
        principal_reason: `Upstream device ${upstreamDeviceId} is currently Critical or Dependency`,
        supporting_evidence: [],
        confidence: "Low",
        duration_seconds: 0,
        dependency_ref: upstreamDeviceId,
      };

  return {
    ...original,
    state: "Dependency",
    explanation,
  };
}

// ---- Recast the matching transition event so the activity feed
// doesn't show a false "went Critical" alert for something that's
// actually just Dependency (DP-003: avoid an alarm storm). ----

function recastTransitionEvent(
  original: StateTransitionEvent,
  upstreamDeviceId: string
): StateTransitionEvent {
  return {
    ...original,
    to_state: "Dependency",
    reason: `Reinterpreted as Dependency - upstream device ${upstreamDeviceId} is down`,
  };
}

// ============================================================
// ILLUSTRATIVE ONLY - not executable, just here to make the shape
// concrete. This is the "at least two devices and a relationship"
// example: a core switch (upstream) and an access switch (downstream)
// that plugs into it.
//
// const dependencies: DependencyRecord[] = [
//   {
//     dependency_id: "dep-1",
//     upstream_device_id: "core-switch-a",
//     downstream_device_id: "access-switch-b",
//     type: "network_uplink",
//     authority: "Configured",
//     confidence: "High",
//     enabled: true,
//   },
// ];
//
// If core-switch-a's raw state is Critical AND access-switch-b's raw
// state is also Critical, this file recasts access-switch-b's
// DISPLAYED state to Dependency, pointing back at core-switch-a as
// the cause - one incident to look at, not two.
// ============================================================
