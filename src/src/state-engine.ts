// ============================================================
// State Engine — Multi-Source Step (spec 5.4, 5.5)
// ============================================================
//
// HOW TO READ THIS FILE (for non-coders):
// This builds directly on the hysteresis version from the last step.
// The one thing it changes: it now understands evidence from all
// three adapters (ICMP, UniFi, and SNMP), not just ICMP. And because
// there are now multiple independent sources, confidence can finally
// reach "High" when two or more of them agree with each other -
// something a single source could never justify on its own, per spec
// 5.4.
//
// Still NOT implemented here (future steps):
//   - The Degraded state (5.2).
//   - Timing-based "independent fault" correlation (5.7) - that gap
//     lives in dependency-evaluator.ts, not here.
//   - duration_seconds is still a placeholder (0).
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
// One of these is kept per device. Each entry now also records WHICH
// source produced it (icmp_reachability vs unifi_device_status) - that's
// what lets us check whether two independent sources actually agree,
// rather than just counting a mixed pile of evidence blindly.

export interface EvidenceWindowEntry {
  polarity: EvidencePolarity;
  timestamp: string;
  evidence_id: string;
  source_type: string; // observation.type this evidence was derived from
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

  const window = appendToWindow(
    previousWindow,
    observation.target,
    evidence,
    observation.type,
    config.window_size
  );

  const fromState: DeviceState = previousState?.state ?? "Unknown";
  const { consecutivePositive, consecutiveNegative, isMixedRecently } = analyseWindow(
    window,
    config
  );
  const sourceAgreement = analyseSourceAgreement(window);

  const toState = deriveState(fromState, consecutivePositive, consecutiveNegative, config);
  const confidence = deriveConfidence(
    toState,
    consecutivePositive,
    consecutiveNegative,
    isMixedRecently,
    sourceAgreement,
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
// Dispatches by observation type. Anything none of the adapters have
// produced yet is treated as neutral, low-weight evidence rather than
// silently guessed at.

function interpretObservation(observation: Observation): Evidence {
  if (observation.type === "icmp_reachability") {
    return interpretIcmpObservation(observation);
  }
  if (observation.type === "unifi_device_status") {
    return interpretUnifiObservation(observation);
  }
  if (observation.type === "snmp_reachability") {
    return interpretSnmpObservation(observation);
  }
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

function interpretIcmpObservation(observation: Observation): Evidence {
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

function interpretSnmpObservation(observation: Observation): Evidence {
  const result = observation.result as { reachable: boolean; error?: string };

  if (result.error) {
    return {
      evidence_id: randomUUID(),
      device_id: observation.target,
      derived_from: [observation.observation_id],
      polarity: "Unavailable", // 5.8: adapter trouble, not necessarily device trouble
      description: `SNMP check failed unexpectedly: ${result.error}`,
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
    description: result.reachable ? "SNMP response received" : "SNMP timeout - no response",
    weight: "moderate", // 5.3: SNMP baseline is corroborating, not authoritative - same tier as ICMP
    timestamp: observation.timestamp,
  };
}

function interpretUnifiObservation(observation: Observation): Evidence {
  const result = observation.result as {
    vendor_state: "online" | "offline" | "unknown";
    raw_state?: string;
    error?: string;
  };

  if (result.error) {
    return {
      evidence_id: randomUUID(),
      device_id: observation.target,
      derived_from: [observation.observation_id],
      polarity: "Unavailable", // 5.8: UniFi API trouble, not necessarily device trouble
      description: `UniFi API check failed unexpectedly: ${result.error}`,
      weight: "weak",
      timestamp: observation.timestamp,
    };
  }

  if (result.vendor_state === "unknown") {
    // UniFi responded, but with a status we don't explicitly recognise.
    // DM-002: represented as genuinely ambiguous, not guessed at.
    return {
      evidence_id: randomUUID(),
      device_id: observation.target,
      derived_from: [observation.observation_id],
      polarity: "Neutral",
      description: `UniFi reported an unrecognised device status${
        result.raw_state ? ` ("${result.raw_state}")` : ""
      }`,
      weight: "weak",
      timestamp: observation.timestamp,
    };
  }

  const polarity: EvidencePolarity = result.vendor_state === "online" ? "Positive" : "Negative";

  return {
    evidence_id: randomUUID(),
    device_id: observation.target,
    derived_from: [observation.observation_id],
    polarity,
    description: result.vendor_state === "online" ? "UniFi reports device online" : "UniFi reports device offline",
    weight: "strong", // 5.3: vendor-reported state outranks ICMP alone when it's actually available
    timestamp: observation.timestamp,
  };
}

// ---- Step 2: fold the new Evidence into the rolling window ----

function appendToWindow(
  previousWindow: DeviceEvidenceWindow | undefined,
  deviceId: string,
  evidence: Evidence,
  sourceType: string,
  windowSize: number
): DeviceEvidenceWindow {
  const entries = previousWindow ? [...previousWindow.entries] : [];
  entries.push({
    polarity: evidence.polarity,
    timestamp: evidence.timestamp,
    evidence_id: evidence.evidence_id,
    source_type: sourceType,
  });

  // Keep only the most recent `windowSize` entries - this is deliberately
  // a rolling window (5.5), not a full history.
  const trimmed = entries.slice(-windowSize);

  return { device_id: deviceId, entries: trimmed };
}

// ---- Step 3: read the window for consecutive runs ----
// Counts trailing runs of Positive / Negative from the newest entry
// backwards, regardless of which source produced them - two different
// sources both reporting bad in a row still counts as a run. Anything
// else (Neutral, Unavailable, Stale, Contradictory) breaks a run rather
// than extending it - it isn't clear evidence either way.

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

// ---- Step 3b: check independent source agreement (5.4) ----
// Looks at the MOST RECENT clear reading (Positive or Negative) from
// each distinct source in the window. If two or more sources currently
// agree, that's the "independent agreement" 5.4 requires for High
// confidence. If they actively disagree, that's a real contradiction -
// not just one flaky source - and confidence should drop accordingly.

function analyseSourceAgreement(window: DeviceEvidenceWindow): {
  agreeingSources: number;
  disagreement: boolean;
} {
  const latestBySource = new Map<string, EvidencePolarity>();

  for (let i = window.entries.length - 1; i >= 0; i--) {
    const entry = window.entries[i];
    if (entry.polarity !== "Positive" && entry.polarity !== "Negative") continue;
    if (!latestBySource.has(entry.source_type)) {
      latestBySource.set(entry.source_type, entry.polarity);
    }
  }

  const polarities = Array.from(latestBySource.values());
  const positives = polarities.filter((p) => p === "Positive").length;
  const negatives = polarities.filter((p) => p === "Negative").length;

  return {
    agreeingSources: Math.max(positives, negatives),
    disagreement: positives > 0 && negatives > 0,
  };
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
  return currentState;
}

// ---- Step 5: confidence reflects how solid the evidence is (5.4) ----
// A single source, however consistent, is capped at Moderate. High
// confidence now requires two or more independent sources currently
// agreeing - exactly the bar 5.4 sets, and something ICMP alone could
// never clear on its own.

function deriveConfidence(
  state: DeviceState,
  consecutivePositive: number,
  consecutiveNegative: number,
  isMixedRecently: boolean,
  sourceAgreement: { agreeingSources: number; disagreement: boolean },
  config: HysteresisConfig
): Confidence {
  if (isMixedRecently || sourceAgreement.disagreement) {
    // Either one source is flapping, or two independent sources are
    // actively disagreeing right now - either way, confidence drops
    // (5.4: conflicting evidence decreases confidence), even if the
    // displayed state hasn't changed yet.
    return "Low";
  }
  if (state === "Unknown") {
    return "Low";
  }
  const metThreshold =
    (state === "Critical" && consecutiveNegative >= config.escalate_after_consecutive_failures) ||
    (state === "Healthy" && consecutivePositive >= config.recover_after_consecutive_successes);

  if (!metThreshold) {
    return "Low";
  }

  return sourceAgreement.agreeingSources >= 2 ? "High" : "Moderate";
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

  // Wording no longer assumes ICMP specifically - consecutive failures
  // can now come from either source, or a mix of both.
  const principal_reason =
    state === "Critical"
      ? `${consecutiveNegative} consecutive failed checks (latest: ${evidence.description})`
      : evidence.description;

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
