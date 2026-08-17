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
// Also now implements the Degraded state (5.2), driven by SNMP
// interface counters (snmp-adapter.ts's runSnmpInterfaceHealthCheck) -
// see interpretSnmpInterfaceObservation and the severity field on
// Evidence (domain-model.ts) below. Degraded uses the SAME consecutive-
// run hysteresis machinery as Critical/Healthy, not a bypass of it - a
// run of Negative evidence escalates to Degraded only while every
// entry in it is explicitly "moderate" severity; a "severe" (or
// unclassified - see the fail-safe note on Evidence.severity) entry
// anywhere in that run escalates to Critical instead, same as today.
//
// Still NOT implemented here (future steps):
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
import type { InterfaceCounterReading } from "./snmp-adapter";

// ---- Configuration (spec 5.5, SE-004: escalation and recovery may use separate thresholds) ----

export interface HysteresisConfig {
  escalate_after_consecutive_failures: number; // negative evidence needed in a row to go Critical
  escalate_to_degraded_after_consecutive_moderate: number; // consecutive ALL-moderate negative evidence
                                                              // needed to go Degraded instead (see file header)
  recover_after_consecutive_successes: number; // positive evidence needed in a row to go Healthy
  window_size: number; // how many recent evidence results to retain per device
}

// Confirmed defaults - "Balanced" on both questions:
// ~3 bad checks (roughly 90-180s at a 30-60s poll interval) to escalate,
// ~2 good checks (roughly 60-120s) to recover.
export const DEFAULT_HYSTERESIS_CONFIG: HysteresisConfig = {
  escalate_after_consecutive_failures: 3,
  // PROVISIONAL - same cadence as Critical for now, pending real
  // traffic data from an actual deployment to justify a different
  // number. Tunable independently of the Critical threshold above.
  escalate_to_degraded_after_consecutive_moderate: 3,
  recover_after_consecutive_successes: 2,
  window_size: 20, // matches the dashboard's existing 20-check history strip
};

// ---- Degraded-evidence thresholds (SNMP interface counters) ----
// PROVISIONAL - placeholder numbers pending real traffic data, not
// settled values. Kept separate from HysteresisConfig above: this
// governs what counts as "moderate" evidence in the first place
// (an interpretation question); HysteresisConfig's new field governs
// how many in a row before the DEVICE state itself flips to Degraded
// (a hysteresis question) - two different, independently tunable calls.

export interface InterfaceHealthConfig {
  degraded_error_rate_per_sec: number;  // summed in+out errors/sec that counts as "elevated"
  degraded_utilization_percent: number; // sustained utilization % that counts as "elevated"
}

export const DEFAULT_INTERFACE_HEALTH_CONFIG: InterfaceHealthConfig = {
  degraded_error_rate_per_sec: 1,    // PROVISIONAL: >=1 error/sec sustained is already unusual on a healthy link
  degraded_utilization_percent: 90,  // PROVISIONAL: sustained >=90% utilization
};

// ---- Persisted raw SNMP interface-counter reading ----
// Bundles a timestamp with the readings because computing a RATE needs
// both endpoints of the interval, not just the two counter values -
// mirrors DeviceEvidenceWindow below in spirit (state that must
// survive a restart, persisted by persistence.ts).

export interface InterfaceCounterSnapshot {
  polled_at: string; // ISO-8601
  readings: InterfaceCounterReading[];
}

// ---- The rolling window itself ----
// One of these is kept per device. Each entry now also records WHICH
// source produced it (icmp_reachability vs unifi_device_status) - that's
// what lets us check whether two independent sources actually agree,
// rather than just counting a mixed pile of evidence blindly.

export interface EvidenceWindowEntry {
  polarity: EvidencePolarity;
  severity?: "moderate" | "severe"; // carried through from Evidence.severity - without this, deriveState
                                      // could only ever see THIS poll's severity, not the window's history,
                                      // and couldn't tell an all-moderate run from one containing a severe entry
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
  evidence?: Evidence; // absent when this cycle's observation produced no evidence at all - e.g. an
                         // SNMP interface counter reset/wraparound is device-lifecycle data, not a
                         // judgement about health (see interpretSnmpInterfaceObservation below)
  window: DeviceEvidenceWindow; // updated window - caller persists this for next time
  transitionEvent?: StateTransitionEvent; // only present if the state actually changed
  interfaceSnapshot?: InterfaceCounterSnapshot; // new raw SNMP interface-counter reading to persist for
                                                  // next cycle's delta - only set for snmp_interface_health
                                                  // observations. Caller persists via persistence.ts.
}

// ---- The State Engine's job: fold one new Observation into the
// device's rolling window, then decide whether that's enough to
// change state. ----

export function evaluateDeviceState(
  observation: Observation,
  previousState: DeviceStateRecord | undefined,
  previousWindow: DeviceEvidenceWindow | undefined,
  config: HysteresisConfig = DEFAULT_HYSTERESIS_CONFIG,
  previousInterfaceSnapshot?: InterfaceCounterSnapshot
): StateEvaluationResult {
  const interpreted = interpretObservation(observation, previousInterfaceSnapshot);
  const fromState: DeviceState = previousState?.state ?? "Unknown";

  if (!interpreted.evidence) {
    // Discarded cycle - e.g. an SNMP interface counter reset/reboot,
    // device-lifecycle data rather than evidence about health (see
    // interpretSnmpInterfaceObservation). State and window are left
    // exactly as they were; only the raw reading baseline moves
    // forward, so the NEXT cycle compares against real values instead
    // of the stale pre-reboot ones.
    return {
      state: previousState ?? unknownStateRecord(observation),
      window: previousWindow ?? { device_id: observation.target, entries: [] },
      interfaceSnapshot: interpreted.interfaceSnapshot,
    };
  }

  const evidence = interpreted.evidence;
  const window = appendToWindow(
    previousWindow,
    observation.target,
    evidence,
    observation.type,
    config.window_size
  );

  const { consecutivePositive, consecutiveNegative, consecutiveNegativeAllModerate, isMixedRecently } =
    analyseWindow(window, config);
  const sourceAgreement = analyseSourceAgreement(window);

  const toState = deriveState(
    fromState,
    consecutivePositive,
    consecutiveNegative,
    consecutiveNegativeAllModerate,
    config
  );
  const confidence = deriveConfidence(
    toState,
    consecutivePositive,
    consecutiveNegative,
    consecutiveNegativeAllModerate,
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

  return { state: stateRecord, evidence, window, transitionEvent, interfaceSnapshot: interpreted.interfaceSnapshot };
}

function unknownStateRecord(observation: Observation): DeviceStateRecord {
  return { device_id: observation.target, state: "Unknown", confidence: "Low", since: observation.timestamp };
}

// ---- Step 1: Observation -> Evidence ----
// Dispatches by observation type. Anything none of the adapters have
// produced yet is treated as neutral, low-weight evidence rather than
// silently guessed at. Returns an interfaceSnapshot alongside evidence
// only for snmp_interface_health - every other branch leaves it unset.

interface InterpretedObservation {
  evidence?: Evidence;
  interfaceSnapshot?: InterfaceCounterSnapshot;
}

function interpretObservation(
  observation: Observation,
  previousInterfaceSnapshot?: InterfaceCounterSnapshot
): InterpretedObservation {
  if (observation.type === "icmp_reachability") {
    return { evidence: interpretIcmpObservation(observation) };
  }
  if (observation.type === "unifi_device_status") {
    return { evidence: interpretUnifiObservation(observation) };
  }
  if (observation.type === "snmp_reachability") {
    return { evidence: interpretSnmpObservation(observation) };
  }
  if (observation.type === "snmp_interface_health") {
    return interpretSnmpInterfaceObservation(observation, previousInterfaceSnapshot);
  }
  return {
    evidence: {
      evidence_id: randomUUID(),
      device_id: observation.target,
      derived_from: [observation.observation_id],
      polarity: "Neutral",
      description: `Unrecognised observation type: ${observation.type}`,
      weight: "weak",
      timestamp: observation.timestamp,
    },
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
    severity: result.reachable ? undefined : "severe", // full unreachability - the highest severity tier
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
    severity: result.reachable ? undefined : "severe", // full unreachability - the highest severity tier
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
    severity: result.vendor_state === "online" ? undefined : "severe", // full unreachability - the highest severity tier
    description: result.vendor_state === "online" ? "UniFi reports device online" : "UniFi reports device offline",
    weight: "strong", // 5.3: vendor-reported state outranks ICMP alone when it's actually available
    timestamp: observation.timestamp,
  };
}

// ---- snmp_interface_health -> Evidence (Degraded-state signal) ----
// Per-interface error-rate/utilization evidence, computed as a DELTA
// against the persisted prior reading - SNMP interface counters are
// cumulative, so a single reading says nothing about a rate. A reboot
// or counter wraparound makes the new reading LOWER than the prior
// one; that's device-lifecycle data, not a real negative delta, so
// that interface's reading is discarded for this cycle rather than
// treated as a meaningless-but-huge error spike. If EVERY monitored
// interface is unusable this cycle (all wrapped, or none have a prior
// baseline yet), the whole cycle is discarded - no Evidence at all,
// see evaluateDeviceState's handling of interpreted.evidence === undefined.

function interpretSnmpInterfaceObservation(
  observation: Observation,
  previousSnapshot: InterfaceCounterSnapshot | undefined,
  config: InterfaceHealthConfig = DEFAULT_INTERFACE_HEALTH_CONFIG
): InterpretedObservation {
  const result = observation.result as { readings: InterfaceCounterReading[]; error?: string };

  if (result.error) {
    return {
      evidence: {
        evidence_id: randomUUID(),
        device_id: observation.target,
        derived_from: [observation.observation_id],
        polarity: "Unavailable", // adapter trouble, not necessarily device trouble - same distinction as
                                   // every other check in this file draws for its own unexpected errors
        description: `SNMP interface health check failed unexpectedly: ${result.error}`,
        weight: "weak",
        timestamp: observation.timestamp,
      },
    };
  }

  if (result.readings.length === 0) {
    // No response this cycle (normal timeout, or no monitored
    // interfaces responded) - not evidence either way. "Unavailable"
    // breaks rather than extends a run, same as an adapter-trouble
    // branch elsewhere in this file.
    return {
      evidence: {
        evidence_id: randomUUID(),
        device_id: observation.target,
        derived_from: [observation.observation_id],
        polarity: "Unavailable",
        description: "SNMP interface health check returned no data",
        weight: "weak",
        timestamp: observation.timestamp,
      },
    };
  }

  const newSnapshot: InterfaceCounterSnapshot = { polled_at: observation.timestamp, readings: result.readings };

  if (!previousSnapshot) {
    // First-ever reading - no baseline to diff against yet. Persist it
    // as next cycle's baseline; no evidence this cycle either way.
    return { interfaceSnapshot: newSnapshot };
  }

  const elapsedSeconds =
    (new Date(observation.timestamp).getTime() - new Date(previousSnapshot.polled_at).getTime()) / 1000;
  const priorByIndex = new Map(previousSnapshot.readings.map((r) => [r.if_index, r]));

  const rates = result.readings
    .map((reading) => {
      const prior = priorByIndex.get(reading.if_index);
      if (!prior) return null; // new interface since last cycle - no baseline yet
      return computeInterfaceRate(prior, reading, elapsedSeconds);
    })
    .filter((r): r is InterfaceRate => r !== null);

  if (rates.length === 0) {
    // Every monitored interface either has no prior baseline yet or
    // showed a counter wraparound/reboot this cycle - device-lifecycle
    // data, not evidence. Discard, but still persist the new snapshot
    // so the NEXT cycle has a real baseline instead of comparing
    // across the gap.
    return { interfaceSnapshot: newSnapshot };
  }

  const breaching = rates.filter(
    (r) =>
      r.error_rate_per_sec >= config.degraded_error_rate_per_sec ||
      (r.utilization_percent !== null && r.utilization_percent >= config.degraded_utilization_percent)
  );

  if (breaching.length === 0) {
    return {
      evidence: {
        evidence_id: randomUUID(),
        device_id: observation.target,
        derived_from: [observation.observation_id],
        polarity: "Positive",
        description: "SNMP interface counters within normal range",
        weight: "moderate",
        timestamp: observation.timestamp,
      },
      interfaceSnapshot: newSnapshot,
    };
  }

  const worst = breaching.reduce((a, b) => (b.error_rate_per_sec > a.error_rate_per_sec ? b : a));
  const utilizationNote =
    worst.utilization_percent !== null ? `, ${worst.utilization_percent.toFixed(1)}% utilization` : "";

  return {
    evidence: {
      evidence_id: randomUUID(),
      device_id: observation.target,
      derived_from: [observation.observation_id],
      polarity: "Negative",
      severity: "moderate", // interface-level degradation, not full unreachability - see fail-safe note
                              // on Evidence.severity (domain-model.ts) for why this is never the DEFAULT
      description: `Interface ${worst.if_index}: ${worst.error_rate_per_sec.toFixed(2)} errors/sec${utilizationNote}${
        breaching.length > 1 ? ` (+${breaching.length - 1} other interface${breaching.length > 2 ? "s" : ""})` : ""
      }`,
      weight: "moderate",
      timestamp: observation.timestamp,
    },
    interfaceSnapshot: newSnapshot,
  };
}

interface InterfaceRate {
  if_index: string;
  error_rate_per_sec: number;
  utilization_percent: number | null; // null when ifHighSpeed is unknown/zero - can't compute a percentage
}

function computeInterfaceRate(
  prior: InterfaceCounterReading,
  current: InterfaceCounterReading,
  elapsedSeconds: number
): InterfaceRate | null {
  if (elapsedSeconds <= 0) return null; // clock issue or same-cycle replay - can't compute a rate

  const inErr = numericDelta(prior.if_in_errors, current.if_in_errors);
  const outErr = numericDelta(prior.if_out_errors, current.if_out_errors);
  const inOctets = bigintDelta(prior.if_hc_in_octets, current.if_hc_in_octets);
  const outOctets = bigintDelta(prior.if_hc_out_octets, current.if_hc_out_octets);

  // A missing or wrapped/reset counter makes this WHOLE interface's
  // reading unusable this cycle - device-lifecycle data, not evidence.
  if (inErr === null || outErr === null || inOctets === null || outOctets === null) {
    return null;
  }

  const errorRatePerSec = (inErr + outErr) / elapsedSeconds;

  let utilizationPercent: number | null = null;
  if (current.if_high_speed_mbps && current.if_high_speed_mbps > 0) {
    // The delta itself is computed in bigint (safe for a 64-bit
    // cumulative counter); converting to Number here is safe because a
    // delta over one poll interval is always small relative to
    // Number.MAX_SAFE_INTEGER, even at very high link speeds.
    const totalOctets = Number(inOctets + outOctets);
    const bitsPerSec = (totalOctets * 8) / elapsedSeconds;
    const linkBitsPerSec = current.if_high_speed_mbps * 1_000_000;
    utilizationPercent = (bitsPerSec / linkBitsPerSec) * 100;
  }

  return { if_index: current.if_index, error_rate_per_sec: errorRatePerSec, utilization_percent: utilizationPercent };
}

function numericDelta(prior: number | undefined, current: number | undefined): number | null {
  if (prior === undefined || current === undefined) return null;
  if (current < prior) return null; // wraparound/reboot - discard
  return current - prior;
}

function bigintDelta(prior: string | undefined, current: string | undefined): bigint | null {
  if (prior === undefined || current === undefined) return null;
  const priorBig = BigInt(prior);
  const currentBig = BigInt(current);
  if (currentBig < priorBig) return null; // wraparound/reboot - discard
  return currentBig - priorBig;
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
    severity: evidence.severity,
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
): {
  consecutivePositive: number;
  consecutiveNegative: number;
  consecutiveNegativeAllModerate: boolean; // true iff consecutiveNegative > 0 AND every entry in that
                                             // trailing run is explicitly "moderate" severity - see
                                             // deriveState below for how this decides Degraded vs. Critical
  isMixedRecently: boolean;
} {
  const entries = window.entries;

  let consecutivePositive = 0;
  for (let i = entries.length - 1; i >= 0 && entries[i].polarity === "Positive"; i--) {
    consecutivePositive++;
  }

  // consecutiveNegativeAllModerate starts true and flips to false the
  // moment ANY entry in the trailing run isn't explicitly "moderate" -
  // that includes "severe" AND unset severity (fail-safe default, see
  // Evidence.severity in domain-model.ts). So a run can only ever count
  // toward Degraded while it is PURELY moderate throughout; one severe
  // (or unclassified) entry anywhere in the unbroken run rules it out,
  // even if the most recent few entries are moderate - "moderate never
  // masks or delays a severe result."
  let consecutiveNegative = 0;
  let consecutiveNegativeAllModerate = true;
  for (let i = entries.length - 1; i >= 0 && entries[i].polarity === "Negative"; i--) {
    consecutiveNegative++;
    if (entries[i].severity !== "moderate") {
      consecutiveNegativeAllModerate = false;
    }
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

  return { consecutivePositive, consecutiveNegative, consecutiveNegativeAllModerate, isMixedRecently };
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
  consecutiveNegativeAllModerate: boolean,
  config: HysteresisConfig
): DeviceState {
  // A run only escalates to Critical if it contains a severe (or
  // unclassified - fail-safe default) entry; a purely-moderate run,
  // however long, escalates to Degraded instead. This is "severe
  // wins": once any severe entry is anywhere in the still-unbroken
  // run, it stays Critical-eligible even if recent entries are
  // moderate - moderate evidence never masks or delays it.
  if (consecutiveNegative >= config.escalate_after_consecutive_failures && !consecutiveNegativeAllModerate) {
    return "Critical";
  }
  if (
    consecutiveNegativeAllModerate &&
    consecutiveNegative >= config.escalate_to_degraded_after_consecutive_moderate
  ) {
    return "Degraded";
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
  consecutiveNegativeAllModerate: boolean,
  isMixedRecently: boolean,
  sourceAgreement: { agreeingSources: number; disagreement: boolean },
  config: HysteresisConfig
): Confidence {
  if (isMixedRecently || sourceAgreement.disagreement) {
    // Either one source is flapping, or two independent sources are
    // actively disagreeing right now - either way, confidence drops
    // (5.4: conflicting evidence decreases confidence), even if the
    // displayed state hasn't changed yet. This also naturally covers a
    // device that's Degraded while still reachable (interface evidence
    // Negative, reachability evidence Positive) - a genuinely mixed
    // signal, not a bug, so Low here is the right call.
    return "Low";
  }
  if (state === "Unknown") {
    return "Low";
  }
  const metThreshold =
    (state === "Critical" &&
      consecutiveNegative >= config.escalate_after_consecutive_failures &&
      !consecutiveNegativeAllModerate) ||
    (state === "Degraded" &&
      consecutiveNegativeAllModerate &&
      consecutiveNegative >= config.escalate_to_degraded_after_consecutive_moderate) ||
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
    state === "Critical"
      ? "Device unreachable"
      : state === "Degraded"
        ? "Device experiencing elevated interface errors or utilization"
        : "Insufficient evidence to determine condition";

  // Wording no longer assumes ICMP specifically - consecutive failures
  // can now come from either source, or a mix of both.
  const principal_reason =
    state === "Critical" || state === "Degraded"
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
