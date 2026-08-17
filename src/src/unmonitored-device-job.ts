// ============================================================
// Unmonitored Device Detection — MVP-ONLY STOPGAP
// ============================================================
//
// DO NOT treat this as permanent architecture. This exists because
// the MVP doesn't (and shouldn't) have a real device-onboarding flow
// yet - it's a workaround for that gap, not the answer to it. The
// long-term/Core-product answer to "how does a client add a device"
// is a real onboarding flow, not "RackWatch silently detects it,
// emails us, and we log in and fix it by hand." If you're building on
// top of this file, stop and check whether what you actually need is
// real onboarding instead.
//
// HOW TO READ THIS FILE (for non-coders):
// Periodically compares "every MAC address UniFi's controller
// currently sees" against "every MAC address RackWatch already has on
// file for a known Device." A MAC that shows up consistently on the
// UniFi side but never appears on the RackWatch side is a coverage
// gap - a device nobody told RackWatch about. This file notices that
// gap and emails RackWatch (not the client) about it.
//
// Deliberately NOT part of the Observation -> Evidence -> State
// pipeline. Adapters (icmp/unifi/snmp-adapter.ts) report observations
// about devices RackWatch already knows about; they don't get to
// invent new devices. This is a separate, standalone job - it never
// touches interpretObservation, state-engine.ts, or Device.current_state.
//
// HARD REQUIREMENT for this job to self-clear correctly: whenever a
// pending-device alert is resolved by manually adding the device to
// config.ts, its MAC address MUST be recorded in Device.addresses
// (type: "mac"). Without that, this job has no way to ever recognise
// the device as no longer missing, and the 48h reminder will keep
// firing indefinitely about a device that's already been handled.
// This is deliberately a documented process requirement, not new
// matching logic (e.g. IP-based fallback matching) - a one-line
// requirement solves this more simply than more code would.
// ============================================================

import type { Device } from "./domain-model";
import { listUnifiDevices, listUnifiClients, type UnifiIntegrationConfig } from "./unifi-adapter";

const REMINDER_AFTER_HOURS = 48; // per spec - exactly one follow-up, then stop. Not provisional/tunable
                                   // like the presence threshold below - this one's a deliberate policy call.

// ---- Configuration ----

export interface UnmonitoredDeviceJobConfig {
  unifi: UnifiIntegrationConfig;
  dante_vlan_id: string; // explicit config value - listUnifiClients is scoped to exactly this VLAN.
                           // listUnifiDevices (infrastructure hardware) has no VLAN concept at all -
                           // see unifi-adapter.ts's header note on why these are separate functions,
                           // not one call sharing a "vlan scope" parameter.
}

// PROVISIONAL - placeholder numbers pending real traffic/usage data
// from the actual MVP deployment, not settled values. Both conditions
// must hold (not either/or) before a candidate is treated as a real
// device rather than e.g. an engineer's laptop briefly plugged in to
// test something.
export interface SustainedPresenceConfig {
  min_consecutive_polls: number;
  min_hours: number;
}

export const DEFAULT_SUSTAINED_PRESENCE_CONFIG: SustainedPresenceConfig = {
  min_consecutive_polls: 3, // PROVISIONAL
  min_hours: 2,              // PROVISIONAL
};

// ---- The pending-device record (persistence.ts persists this) ----

export interface PendingDeviceRecord {
  mac: string;
  vlan?: string;
  label?: string;               // human-readable name from UniFi, when available - makes the eventual
                                  // email meaningfully more actionable ("AA:BB:CC (FOH-DSP-2)" vs "AA:BB:CC")
  first_detected_at: string;    // ISO-8601 - when this MAC was FIRST seen as unmatched
  times_seen: number;            // consecutive reconciliation cycles seen as unmatched, WITHOUT a gap -
                                   // a gap (e.g. a laptop disconnecting) drops the record entirely rather
                                   // than pausing the counter; if the MAC reappears later it starts fresh
  notified_at?: string;          // set once, the cycle this record first crossed the presence threshold
  reminder_sent_at?: string;     // set once, if still unresolved REMINDER_AFTER_HOURS after notified_at
}

// ---- What the UniFi side currently sees, decoupled from any
// particular fetch mechanism - lets computeReconciliation below be
// tested with fabricated data, no network involved. ----

export interface SeenMacEntry {
  mac: string;
  vlan?: string;
  label?: string;
}

export interface ReconciliationResult {
  pending: PendingDeviceRecord[];  // full updated pending set - caller persists this, replacing the old set
  newBatch: PendingDeviceRecord[];  // just crossed the presence threshold THIS cycle - queue ONE email
                                      // covering all of these (batch, don't spam)
  reminderBatch: PendingDeviceRecord[]; // already notified, still unresolved after 48h - queue ONE
                                          // reminder email covering all of these
  resolvedMacs: string[];          // previously pending, now matched in the known Device table - self-
                                     // cleared. Logging/observability only, not acted on further here.
}

// ---- Step 1: what MACs does RackWatch already know about? ----
// Case-insensitive by construction - toEnumeratedDevice/toEnumeratedClient
// in unifi-adapter.ts already lower-case theirs, so this must too or
// every comparison would silently fail.

export function knownMacsFromDevices(devices: Device[]): Set<string> {
  const macs = new Set<string>();
  for (const device of devices) {
    for (const address of device.addresses) {
      if (address.type === "mac") macs.add(address.value.toLowerCase());
    }
  }
  return macs;
}

// ---- Diagnostic, not matching logic: which known devices have NO
// MAC on file at all, and are therefore invisible to the diff above -
// they can never be matched, so a real device could get permanently
// misflagged as "unmonitored." This surfaces the gap; it does not
// paper over it with a weaker (e.g. IP-based) matching fallback. ----

export function findDevicesMissingMac(devices: Device[]): string[] {
  return devices.filter((d) => !d.addresses.some((a) => a.type === "mac")).map((d) => d.device_id);
}

// ---- Step 2: the actual diff/threshold/batching logic. Pure aside
// from its inputs - no network, no persistence, no Date.now() (now is
// threaded through explicitly, same reproducibility principle
// incident-engine.ts already follows). ----

export function computeReconciliation(
  seenMacs: SeenMacEntry[],
  knownMacs: Set<string>,
  previousPending: PendingDeviceRecord[],
  now: string,
  config: SustainedPresenceConfig = DEFAULT_SUSTAINED_PRESENCE_CONFIG
): ReconciliationResult {
  const previousByMac = new Map(previousPending.map((r) => [r.mac, r]));
  const unmatched = seenMacs.filter((s) => s.mac && !knownMacs.has(s.mac));

  const pending: PendingDeviceRecord[] = [];
  const newBatch: PendingDeviceRecord[] = [];
  const reminderBatch: PendingDeviceRecord[] = [];
  const handledMacs = new Set<string>();

  for (const seen of unmatched) {
    handledMacs.add(seen.mac);
    const existing = previousByMac.get(seen.mac);

    const record: PendingDeviceRecord = existing
      ? {
          ...existing,
          vlan: seen.vlan ?? existing.vlan,
          label: seen.label ?? existing.label,
          times_seen: existing.times_seen + 1,
        }
      : { mac: seen.mac, vlan: seen.vlan, label: seen.label, first_detected_at: now, times_seen: 1 };

    // Gate on !record.notified_at - this is the whole fix for
    // repeat-batching. Without this check, every currently-unmatched
    // MAC would qualify again on every single cycle regardless of
    // notification history, and the same batch email would repeat
    // every poll ("don't spam" failing silently).
    if (!record.notified_at && hasSustainedPresence(record, now, config)) {
      record.notified_at = now;
      newBatch.push(record);
    }

    if (record.notified_at && !record.reminder_sent_at && hoursSince(record.notified_at, now) >= REMINDER_AFTER_HOURS) {
      record.reminder_sent_at = now;
      reminderBatch.push(record);
    }

    pending.push(record);
  }

  // Anything previously pending but NOT seen as unmatched this cycle -
  // either self-cleared (its MAC is now in the known Device table) or
  // simply vanished (e.g. a laptop disconnecting before ever crossing
  // the presence threshold). Either way it's dropped from `pending` -
  // self-clearing is automatic, not a separate "mark resolved" step.
  // Only the genuinely-self-cleared ones are worth reporting.
  const resolvedMacs = previousPending
    .filter((r) => !handledMacs.has(r.mac) && knownMacs.has(r.mac))
    .map((r) => r.mac);

  return { pending, newBatch, reminderBatch, resolvedMacs };
}

function hasSustainedPresence(record: PendingDeviceRecord, now: string, config: SustainedPresenceConfig): boolean {
  return record.times_seen >= config.min_consecutive_polls && hoursSince(record.first_detected_at, now) >= config.min_hours;
}

function hoursSince(earlier: string, later: string): number {
  return (new Date(later).getTime() - new Date(earlier).getTime()) / 3_600_000;
}

// ---- Step 3: fetch what UniFi currently sees. Decoupled from
// computeReconciliation above so the diff/threshold/batching logic
// can be tested without hitting the network at all. ----

export async function fetchSeenMacs(jobConfig: UnmonitoredDeviceJobConfig): Promise<{ seen: SeenMacEntry[]; error?: string }> {
  const [devicesResult, clientsResult] = await Promise.all([
    listUnifiDevices(jobConfig.unifi),
    listUnifiClients(jobConfig.unifi, jobConfig.dante_vlan_id),
  ]);

  const errors = [devicesResult.error, clientsResult.error].filter((e): e is string => !!e);

  // A MAC seen on both lists (shouldn't normally happen - devices and
  // clients are different UniFi object types) just collapses to one
  // entry; last-write-wins is fine here, this is diagnostic labelling,
  // not evidence.
  const seenByMac = new Map<string, SeenMacEntry>();
  for (const d of devicesResult.items) {
    if (!d.mac) continue;
    seenByMac.set(d.mac, { mac: d.mac, label: d.name });
  }
  for (const c of clientsResult.items) {
    if (!c.mac) continue;
    seenByMac.set(c.mac, { mac: c.mac, label: c.name, vlan: c.vlan_id });
  }

  return { seen: Array.from(seenByMac.values()), error: errors.length > 0 ? errors.join("; ") : undefined };
}

// ---- Orchestration: the one function a (currently unwired - see
// file header, scheduling is deliberately deferred) caller would
// invoke periodically. ----

export interface RunReconciliationResult extends ReconciliationResult {
  devicesMissingMac: string[]; // diagnostic - see findDevicesMissingMac above
  fetchError?: string;
}

export async function runReconciliation(
  jobConfig: UnmonitoredDeviceJobConfig,
  knownDevices: Device[],
  previousPending: PendingDeviceRecord[],
  now: string = new Date().toISOString(),
  presenceConfig: SustainedPresenceConfig = DEFAULT_SUSTAINED_PRESENCE_CONFIG
): Promise<RunReconciliationResult> {
  const devicesMissingMac = findDevicesMissingMac(knownDevices);
  if (devicesMissingMac.length > 0) {
    console.warn(
      `[unmonitored-device-job] ${devicesMissingMac.length} known device(s) have no MAC on record - ` +
        `these are invisible to reconciliation matching and may be misflagged as "new": ${devicesMissingMac.join(", ")}`
    );
  }

  const { seen, error: fetchError } = await fetchSeenMacs(jobConfig);
  if (fetchError) {
    console.warn(`[unmonitored-device-job] enumeration had errors this cycle: ${fetchError}`);
  }

  const knownMacs = knownMacsFromDevices(knownDevices);
  const result = computeReconciliation(seen, knownMacs, previousPending, now, presenceConfig);

  return { ...result, devicesMissingMac, fetchError };
}

// ---- Email content ----
// Plain text, internal-only (mailer.ts sends this to the config'd
// alerts recipient, never the client - see file header). Unlike the
// licence-overage email (spec Section 8, deliberately sparse to avoid
// leaking project info to whoever's near the unit), this one can
// include real detail since only RackWatch staff receive it.

export interface EmailContent {
  subject: string;
  body: string;
}

export function buildUnmonitoredDeviceEmail(records: PendingDeviceRecord[], kind: "new" | "reminder"): EmailContent {
  const plural = records.length > 1 ? "s" : "";
  const subject =
    kind === "new"
      ? `RackWatch: ${records.length} unmonitored device${plural} detected`
      : `RackWatch: ${records.length} unmonitored device${plural} still unresolved (48h reminder)`;

  const lines = records.map((r) => {
    const label = r.label ? ` (${r.label})` : "";
    const vlan = r.vlan ? `, VLAN ${r.vlan}` : "";
    return `- ${r.mac}${label}${vlan} - first seen ${r.first_detected_at}`;
  });

  const body = [
    kind === "new"
      ? "The following devices have been consistently present on the network but are not in RackWatch's known Device table:"
      : "The following devices are still unmonitored 48 hours after the first alert - this is the single follow-up reminder, no further escalation will be sent:",
    "",
    ...lines,
    "",
    'IMPORTANT: when adding one of these as a monitored Device, record its MAC address ' +
      '(addresses: [{ type: "mac", value: "..." }]) - without it, this alert cannot self-clear and will keep reporting the device as unmonitored.',
    "",
    "-- RackWatch (MVP unmonitored-device job - see unmonitored-device-job.ts before building anything on top of this)",
  ].join("\n");

  return { subject, body };
}
