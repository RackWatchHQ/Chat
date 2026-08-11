// ============================================================
// Minimal State Engine — Build 1, Step 1 (spec Section 5)
// ============================================================
//
// HOW TO READ THIS FILE (for non-coders):
// This is a DELIBERATELY SIMPLE first version. Its only job is to
// prove that Observation -> Evidence -> State -> Event actually
// works end-to-end. It does NOT yet implement:
//   - the rolling-window / anti-flapping logic (spec 5.5)
//   - dependency evaluation (spec 5.7)
//   - the Degraded state (5.2)
// Those come in later steps, once this simple version is proven
// to work. For now, this engine only ever produces Healthy,
// Critical, or Unknown - and it reacts to a single observation
// at a time, with no memory of history beyond "what was the
// state a moment ago."
//
// IMPORTANT: a single failed ping currently flips a device straight
// to Critical. Spec rule SE-005 explicitly says a single failed
// low-authority check should NOT normally cause an immediate
// Healthy-to-Critical transition. This version breaks that rule on
// purpose, temporarily, to prove the pipeline works before we add
// the hysteresis logic that fixes it. Do not treat this as finished
// behaviour - it isn't.
//
// What THIS FILE does guarantee, per spec 5.1: it is the ONLY place
// that decides current_state. Nothing else in the system may.
// ============================================================

import { randomUUID } from "crypto";
import type {
  Observation,
  Evidence,
  DeviceStateRecord,
  StateTransitionEvent,
  DeviceState,
  EvidencePolarity,
  StateExplanation,
} from "./domain-model";

// ---- What the State Engine hands back after evaluating one Observation ----

export interface StateEvaluationResult {
  state: DeviceStateRecord;
  evidence: Evidence;
  transitionEvent?: StateTransitionEvent; // only present if the state actually changed
}

// ---- The State Engine's one job, in this minimal version:
// take one Observation and the device's previous state, and
// decide the new state. ----

export function evaluateDeviceState(
  observation: Observation,
  previousState: DeviceStateRecord | undefined
): StateEvaluationResult {
  const evidence = interpretObservation(observation);
  const newState = deriveState(evidence);

  const stateRecord: DeviceStateRecord = {
    device_id: observation.target,
    state: newState,
    confidence: "Moderate", // 5.4: a single corroborating-quality source caps confidence at Moderate for now
    since:
      previousState && previousState.state === newState
        ? previousState.since // state hasn't changed - keep the original "since" timestamp
        : observation.timestamp,
    explanation: newState === "Healthy" ? undefined : buildExplanation(newState, evidence),
  };

  const fromState: DeviceState = previousState?.state ?? "Unknown";

  // This is the mechanism behind "alert on transitions, not every poll" -
  // no event is built at all if the state didn't actually change.
  const transitionEvent =
    fromState !== newState
      ? buildTransitionEvent(observation, fromState, newState, evidence)
      : undefined;

  return { state: stateRecord, evidence, transitionEvent };
}

// ---- Step 1: turn the raw Observation into Evidence ----
// Intentionally simple: one ICMP result in, one Evidence out. A real
// State Engine weighs multiple recent observations (5.3, 5.5) - that
// comes later, once this simple version is proven.

function interpretObservation(observation: Observation): Evidence {
  if (observation.type !== "icmp_reachability") {
    // This minimal engine only understands ICMP for now. Anything else
    // becomes neutral, low-weight evidence rather than silently guessing.
    return {
      evidence_id: randomUUID(),
      device_id: observation.target,
      derived_from: [observation.observation_id],
      polarity: "Neutral",
      description: `Unrecognised observation type: ${observation.type}`,
      weight: "weak",
      timestamp: observation.timestamp,
    };
  }

  const result = observation.result as { reachable: boolean; error?: string };

  if (result.error) {
    return {
      evidence_id: randomUUID(),
      device_id: observation.target,
      derived_from: [observation.observation_id],
      polarity: "Unavailable", // 5.3: adapter trouble, not necessarily device trouble
      description: `ICMP check failed unexpectedly: ${result.error}`,
      weight: "weak",
      timestamp: observation.timestamp,
    };
  }

  const polarity: EvidencePolarity = result.reachable ? "Positive" : "Negative";

  return {
    evidence_id: randomUUID(),
    device_id: observation.target,
    derived_from: [observation.observation_id],
    polarity,
    description: result.reachable ? "ICMP response received" : "ICMP timeout - no response",
    weight: "moderate", // 5.3: ICMP alone is corroborating, not authoritative
    timestamp: observation.timestamp,
  };
}

// ---- Step 2: turn Evidence into a State ----
// Minimal version: no rolling window yet, so a single piece of negative
// evidence is enough to flip to Critical. See the file-level warning
// above - this is the part SE-005 requires us to fix next.

function deriveState(evidence: Evidence): DeviceState {
  switch (evidence.polarity) {
    case "Positive":
      return "Healthy";
    case "Negative":
      return "Critical";
    case "Unavailable":
    case "Stale":
    case "Neutral":
    case "Contradictory":
    default:
      return "Unknown";
  }
}

// ---- Step 3: build the required explanation for any non-Healthy state ----
// SE-009: every non-Healthy state shall have a conclusion, principal
// reason, supporting evidence, confidence and duration.

function buildExplanation(state: DeviceState, evidence: Evidence): StateExplanation {
  return {
    conclusion:
      state === "Critical" ? "Device unreachable" : "Insufficient evidence to determine condition",
    principal_reason: evidence.description,
    supporting_evidence: [evidence.evidence_id],
    confidence: "Moderate",
    duration_seconds: 0, // minimal version doesn't yet track how long a state has persisted
  };
}

// ---- Step 4: record a transition event, only when state actually changed ----

function buildTransitionEvent(
  observation: Observation,
  fromState: DeviceState,
  toState: DeviceState,
  evidence: Evidence
): StateTransitionEvent {
  return {
    event_id: randomUUID(),
    device_id: observation.target,
    timestamp: observation.timestamp,
    from_state: fromState,
    to_state: toState,
    reason: evidence.description,
    evidence_ids: [evidence.evidence_id],
  };
}
