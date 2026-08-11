// ============================================================
// State Engine — Hysteresis Step (spec 5.5)
// ============================================================
//
// HOW TO READ THIS FILE (for non-coders):
// This builds directly on the minimal state-engine.ts from the last
// step. The one thing it changes: instead of reacting to a single
// ping result, it now looks at a short rolling history of recent
// results per device, and requires a RUN of consecutive bad results
// before declaring Critical, and a separate run of consecutive good
// results before clearing back to Healthy. This is what stops one
// stray dropped ping from flipping the whole dashboard.
//
// Still NOT implemented here (future steps):
//   - Dependency evaluation (5.7) - a device isn't yet excused from
//     Critical just because its upstream switch is also down.
//   - The Degraded state (5.2).
//   - Any observation type other than ICMP.
//   - duration_seconds is still a placeholder (0) - properly tracking
//     "how long has this state lasted" is a small follow-up, not done here.
//
// Defaults chosen for Build 1 (confirmed with the person building this,
// not guessed):
//   - 3 consecutive failed checks before escalating to Critical
//   - 2 consecutive successful checks before clearing back to Healthy
// These are configuration, not hardcoded logic - see HysteresisConfig
// below. Change the numbers any time without touching the reasoning.
// ============================================================

import { randomUUID } from "crypto";
import type {
  Observation,
  Evidence,
  DeviceStateRecord,
  StateTransitionEvent,
  DeviceState,
  EvidencePolarity,
  Confidence,
  StateExplanation,
} from "./domain-model";

// ---- Configuration (spec 5.5, SE-004: escalation and recovery may use separate thresholds) ----

export interface HysteresisConfig {
  escalate_after_consecutive_failures: number; // negative evidence needed in a row to go Critical
  recover_after_consecutive_successes: number; // positive evidence needed in a row to go Healthy
  window_size: number; // how many recent evidence results to retain per device
}

// Confirmed defaults - "Balanced" on both questions:
// ~3 bad checks (roughly 90-180s at a 30-60s poll interval) to escalate,
// ~2 good checks (roughly 60-120s) to recover.
export const DEFAULT_HYSTERESIS_CONFIG: HysteresisConfig = {
  escalate_after_consecutive_failures: 3,
  recover_after_consecutive_successes: 2,
  window_size: 20, // matches the dashboard's existing 20-check history strip
};

// ---- The rolling window itself ----
// One of these is kept per device. It's just a bounded list of recent
// evidence polarities - deliberately small and serialisable so it can
// be persisted between polls (in a DB, in Build 1's storage layer),
// the same way previousState already needs to be.

export interface EvidenceWindowEntry {
  polarity: EvidencePolarity;
  timestamp: string;
  evidence_id: string;
}

export interface DeviceEvidenceWindow {
  device_id: string;
  entries: EvidenceWindowEntry[]; // oldest first, newest last
}

// ---- What the State Engine hands back after evaluating one Observation ----

export interface StateEvaluationResult {
  state: DeviceStateRecord;
  evidence: Evidence;
  window: DeviceEvidenceWindow; // updated window - caller persists this for next time
  transitionEvent?: StateTransitionEvent; // only present if the state actually changed
}

// ---- The State Engine's job: fold one new Observation into the
// device's rolling window, then decide whether that's enough to
// change state. ----

export function evaluateDeviceState(
  observation: Observation,
  previousState: DeviceStateRecord | undefined,
  previousWindow: DeviceEvidenceWindow | undefined,
  config: HysteresisConfig = DEFAULT_HYSTERESIS_CONFIG
): StateEvaluationResult {
  const evidence = interpretObservation(observation);

  const window = appendToWindow(previousWindow, observation.target, evidence, config.window_size);

  const fromState: DeviceState = previousState?.state ?? "Unknown";
  const { consecutivePositive, consecutiveNegative, isMixedRecently } = analyseWindow(
    window,
    config
  );

  const toState = deriveState(fromState, consecutivePositive, consecutiveNegative, config);
  const confidence = deriveConfidence(
    toState,
    consecutivePositive,
    consecutiveNegative,
    isMixedRecently,
    config
  );

  const stateRecord: DeviceStateRecord = {
    device_id: observation.target,
    state: toState,
    confidence,
    since:
      previousState && previousState.state === toState
        ? previousState.since
        : observation.timestamp,
    explanation:
      toState === "Healthy" ? undefined : buildExplanation(toState, evidence, consecutiveNegative, confidence),
  };

  // SE-005 / SE-006 in action: this only fires when the run of evidence
  // actually crossed a threshold, not on every poll.
  const transitionEvent =
    fromState !== toState
      ? buildTransitionEvent(observation, fromState, toState, evidence)
      : undefined;

  return { state: stateRecord, evidence, window, transitionEvent };
}

// ---- Step 1: Observation -> Evidence ----
// Unchanged from the minimal version - still ICMP-only for now.

function interpretObservation(observation: Observation): Evidence {
  if (observation.type !== "icmp_reachability") {
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
      polarity: "Unavailable",
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
    weight: "moderate",
    timestamp: observation.timestamp,
  };
}

// ---- Step 2: fold the new Evidence into the rolling window ----

function appendToWindow(
  previousWindow: DeviceEvidenceWindow | undefined,
  deviceId: string,
  evidence: Evidence,
  windowSize: number
): DeviceEvidenceWindow {
  const entries = previousWindow ? [...previousWindow.entries] : [];
  entries.push({
    polarity: evidence.polarity,
    timestamp: evidence.timestamp,
    evidence_id: evidence.evidence_id,
  });

  // Keep only the most recent `windowSize` entries - this is deliberately
  // a rolling window (5.5), not a full history.
  const trimmed = entries.slice(-windowSize);

  return { device_id: deviceId, entries: trimmed };
}

// ---- Step 3: read the window for consecutive runs ----
// Counts trailing runs of Positive / Negative from the newest entry
// backwards. Anything else (Neutral, Unavailable, Stale, Contradictory)
// breaks a run rather than extending it - it isn't clear evidence
// either way, so it can't be allowed to silently continue a streak.

function analyseWindow(
  window: DeviceEvidenceWindow,
  config: HysteresisConfig
): { consecutivePositive: number; consecutiveNegative: number; isMixedRecently: boolean } {
  const entries = window.entries;

  let consecutivePositive = 0;
  for (let i = entries.length - 1; i >= 0 && entries[i].polarity === "Positive"; i--) {
    consecutivePositive++;
  }

  let consecutiveNegative = 0;
  for (let i = entries.length - 1; i >= 0 && entries[i].polarity === "Negative"; i--) {
    consecutiveNegative++;
  }

  // "Mixed recently" = within the lookback needed to reach a threshold,
  // there's a mix of Positive and Negative without either run completing.
  // This is what flags a flapping device even before/without a state change.
  const lookback = Math.max(
    config.escalate_after_consecutive_failures,
    config.recover_after_consecutive_successes
  );
  const recent = entries.slice(-lookback);
  const hasPositive = recent.some((e) => e.polarity === "Positive");
  const hasNegative = recent.some((e) => e.polarity === "Negative");
  const isMixedRecently =
    hasPositive &&
    hasNegative &&
    consecutivePositive < config.recover_after_consecutive_successes &&
    consecutiveNegative < config.escalate_after_consecutive_failures;

  return { consecutivePositive, consecutiveNegative, isMixedRecently };
}

// ---- Step 4: decide whether the runs are enough to change state ----
// This is the actual hysteresis: staying put is the default. State
// only moves when a run crosses its threshold (SE-003, SE-005, SE-006).

function deriveState(
  currentState: DeviceState,
  consecutivePositive: number,
  consecutiveNegative: number,
  config: HysteresisConfig
): DeviceState {
  if (consecutiveNegative >= config.escalate_after_consecutive_failures) {
    return "Critical";
  }
  if (consecutivePositive >= config.recover_after_consecutive_successes) {
    return "Healthy";
  }
  // Neither threshold met - hold the current state. This is the rule
  // that stops a single dropped ping (or a single recovered one) from
  // moving anything.
  return currentState;
}

// ---- Step 5: confidence reflects how solid the evidence is (5.4) ----
// Capped at Moderate for now - ICMP is a single, corroborating-only
// source (5.3), and 5.4 requires independent agreement between sources
// to justify High confidence. That becomes possible once the UniFi
// adapter exists and can agree or disagree with ICMP.

function deriveConfidence(
  state: DeviceState,
  consecutivePositive: number,
  consecutiveNegative: number,
  isMixedRecently: boolean,
  config: HysteresisConfig
): Confidence {
  if (isMixedRecently) {
    // Evidence is contradicting itself - state hasn't necessarily
    // changed, but confidence in it should drop (5.4: conflicting
    // evidence decreases confidence).
    return "Low";
  }
  if (state === "Unknown") {
    return "Low";
  }
  const metThreshold =
    (state === "Critical" && consecutiveNegative >= config.escalate_after_consecutive_failures) ||
    (state === "Healthy" && consecutivePositive >= config.recover_after_consecutive_successes);
  return metThreshold ? "Moderate" : "Low";
}

// ---- Step 6: build the required explanation for any non-Healthy state ----
// SE-009: every non-Healthy state shall have a conclusion, principal
// reason, supporting evidence, confidence and duration.

function buildExplanation(
  state: DeviceState,
  evidence: Evidence,
  consecutiveNegative: number,
  confidence: Confidence
): StateExplanation {
  const conclusion =
    state === "Critical" ? "Device unreachable" : "Insufficient evidence to determine condition";

  const principal_reason =
    state === "Critical" ? `${consecutiveNegative} consecutive ICMP timeouts` : evidence.description;

  return {
    conclusion,
    principal_reason,
    supporting_evidence: [evidence.evidence_id],
    confidence,
    duration_seconds: 0, // still not tracked - needs a "since" timestamp diff, a small follow-up
  };
}

// ---- Step 7: record a transition event, only when state actually changed ----

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
