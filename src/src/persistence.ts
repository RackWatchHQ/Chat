// ============================================================
// Persistence Layer — Build 1
// ============================================================
//
// Stores the mutable, per-poll-cycle state the reasoning pipeline
// needs to carry forward between runs: each device's RAW state (fed
// back in as "previousState"), its rolling evidence window, the
// DISPLAYED state shown on the dashboard, the transition-event log,
// and open incidents. Devices/Checks/Dependencies themselves are
// static configuration (see config.ts), not stored here.
//
// Uses Node's built-in node:sqlite (DatabaseSync) rather than
// better-sqlite3 - the native better-sqlite3 bindings don't yet
// build against this Node version's V8 headers, and node:sqlite
// needs no native compilation at all.
// ============================================================

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  DeviceStateRecord,
  StateTransitionEvent,
  StateExplanation,
} from "./domain-model";
import type { DeviceEvidenceWindow, InterfaceCounterSnapshot } from "./state-engine";
import type { Incident } from "./incident-engine";
import type { PendingDeviceRecord } from "./unmonitored-device-job";
import type { DiscoveredHostRecord } from "./discovery-adapter";
import { hostKey } from "./discovery-adapter";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS device_state_raw (
  device_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  confidence TEXT NOT NULL,
  since TEXT NOT NULL,
  explanation TEXT
);

CREATE TABLE IF NOT EXISTS evidence_window (
  device_id TEXT PRIMARY KEY,
  entries TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_state_displayed (
  device_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  confidence TEXT NOT NULL,
  since TEXT NOT NULL,
  explanation TEXT
);

CREATE TABLE IF NOT EXISTS transition_events (
  event_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence_ids TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interface_counter_snapshot (
  device_id TEXT PRIMARY KEY,
  polled_at TEXT NOT NULL,
  readings TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS incidents (
  incident_id TEXT PRIMARY KEY,
  lifecycle_stage TEXT NOT NULL,
  affected_device_ids TEXT NOT NULL,
  most_probable_root_cause TEXT,
  created_at TEXT NOT NULL,
  timeline TEXT NOT NULL,
  consecutive_healthy_cycles INTEGER NOT NULL
);

-- MVP-only stopgap (unmonitored-device-job.ts) - see that file's
-- header before building anything on top of these two tables.

CREATE TABLE IF NOT EXISTS unmonitored_device (
  mac TEXT PRIMARY KEY,
  vlan TEXT,
  label TEXT,
  first_detected_at TEXT NOT NULL,
  times_seen INTEGER NOT NULL,
  notified_at TEXT,
  reminder_sent_at TEXT
);

CREATE TABLE IF NOT EXISTS discovered_host (
  host_key TEXT PRIMARY KEY,
  ip TEXT NOT NULL,
  mac TEXT,
  vendor_guess TEXT,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  added_at TEXT
);

CREATE TABLE IF NOT EXISTS notification_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0
);
`;

export class RackWatchStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);

    // v0.9 spec §3.7 (power-loss resilience): this store must run in WAL
    // mode - it's designed specifically to survive power loss mid-write
    // without corruption, the actual failure mode this appliance is
    // built against (a breaker throw, not a graceful shutdown). Not a
    // one-time migration: journal_mode is a per-connection pragma, so
    // it's set here in the constructor - every connection open, not
    // just once - rather than assumed from the file on disk.
    const { journal_mode: journalMode } = this.db.prepare("PRAGMA journal_mode = WAL").get() as {
      journal_mode: string;
    };
    if (journalMode.toLowerCase() !== "wal" && path !== ":memory:") {
      // :memory: databases can't use WAL and silently fall back - not a
      // problem there. On a real file, failing to land in WAL defeats
      // the whole reason SQLite was chosen, so this is loud on purpose.
      throw new Error(`persistence: expected WAL journal mode for ${path}, got '${journalMode}'`);
    }

    // WAL's standard pairing (v0.9 spec §3.7): NORMAL is safe under WAL
    // specifically - the WAL file itself, not just the main DB, is what
    // guarantees durability, so this doesn't trade away crash-safety to
    // get there.
    this.db.exec("PRAGMA synchronous = NORMAL");

    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---- Raw device state (fed back in as evaluateDeviceState's previousState) ----

  loadAllRawStates(): Map<string, DeviceStateRecord> {
    const rows = this.db.prepare("SELECT * FROM device_state_raw").all() as Array<{
      device_id: string;
      state: string;
      confidence: string;
      since: string;
      explanation: string | null;
    }>;
    return new Map(rows.map((row) => [row.device_id, rowToStateRecord(row)]));
  }

  saveRawState(state: DeviceStateRecord): void {
    this.db
      .prepare(
        `INSERT INTO device_state_raw (device_id, state, confidence, since, explanation)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           state = excluded.state,
           confidence = excluded.confidence,
           since = excluded.since,
           explanation = excluded.explanation`
      )
      .run(
        state.device_id,
        state.state,
        state.confidence,
        state.since,
        state.explanation ? JSON.stringify(state.explanation) : null
      );
  }

  // ---- Rolling evidence window (state-engine's hysteresis input) ----

  loadWindow(deviceId: string): DeviceEvidenceWindow | undefined {
    const row = this.db.prepare("SELECT entries FROM evidence_window WHERE device_id = ?").get(deviceId) as
      | { entries: string }
      | undefined;
    if (!row) return undefined;
    return { device_id: deviceId, entries: JSON.parse(row.entries) };
  }

  saveWindow(window: DeviceEvidenceWindow): void {
    this.db
      .prepare(
        `INSERT INTO evidence_window (device_id, entries)
         VALUES (?, ?)
         ON CONFLICT(device_id) DO UPDATE SET entries = excluded.entries`
      )
      .run(window.device_id, JSON.stringify(window.entries));
  }

  // ---- Last raw SNMP interface-counter reading (state-engine's
  // interface-health delta input - counters are cumulative, so a rate
  // needs the prior reading, mirroring the evidence_window pattern
  // above) ----

  loadInterfaceSnapshot(deviceId: string): InterfaceCounterSnapshot | undefined {
    const row = this.db
      .prepare("SELECT polled_at, readings FROM interface_counter_snapshot WHERE device_id = ?")
      .get(deviceId) as { polled_at: string; readings: string } | undefined;
    if (!row) return undefined;
    return { polled_at: row.polled_at, readings: JSON.parse(row.readings) };
  }

  saveInterfaceSnapshot(deviceId: string, snapshot: InterfaceCounterSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO interface_counter_snapshot (device_id, polled_at, readings)
         VALUES (?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           polled_at = excluded.polled_at,
           readings = excluded.readings`
      )
      .run(deviceId, snapshot.polled_at, JSON.stringify(snapshot.readings));
  }

  // ---- Displayed device state (post dependency-evaluator recast) ----

  loadAllDisplayedStates(): Map<string, DeviceStateRecord> {
    const rows = this.db.prepare("SELECT * FROM device_state_displayed").all() as Array<{
      device_id: string;
      state: string;
      confidence: string;
      since: string;
      explanation: string | null;
    }>;
    return new Map(rows.map((row) => [row.device_id, rowToStateRecord(row)]));
  }

  saveDisplayedState(state: DeviceStateRecord): void {
    this.db
      .prepare(
        `INSERT INTO device_state_displayed (device_id, state, confidence, since, explanation)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           state = excluded.state,
           confidence = excluded.confidence,
           since = excluded.since,
           explanation = excluded.explanation`
      )
      .run(
        state.device_id,
        state.state,
        state.confidence,
        state.since,
        state.explanation ? JSON.stringify(state.explanation) : null
      );
  }

  // ---- Transition event log (append-only) ----

  appendTransitionEvent(event: StateTransitionEvent): void {
    this.db
      .prepare(
        `INSERT INTO transition_events (event_id, device_id, timestamp, from_state, to_state, reason, evidence_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.event_id,
        event.device_id,
        event.timestamp,
        event.from_state,
        event.to_state,
        event.reason,
        JSON.stringify(event.evidence_ids)
      );
  }

  recentTransitionEvents(limit: number): StateTransitionEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM transition_events ORDER BY timestamp DESC LIMIT ?")
      .all(limit) as Array<{
      event_id: string;
      device_id: string;
      timestamp: string;
      from_state: string;
      to_state: string;
      reason: string;
      evidence_ids: string;
    }>;
    return rows.map((row) => ({
      event_id: row.event_id,
      device_id: row.device_id,
      timestamp: row.timestamp,
      from_state: row.from_state as StateTransitionEvent["from_state"],
      to_state: row.to_state as StateTransitionEvent["to_state"],
      reason: row.reason,
      evidence_ids: JSON.parse(row.evidence_ids),
    }));
  }

  // ---- Incidents (IE-005: timeline is append-only/immutable once Resolved -
  // enforced by incident-engine.ts, this layer just persists whatever it hands back) ----

  loadOpenIncidents(): Incident[] {
    const rows = this.db
      .prepare("SELECT * FROM incidents WHERE lifecycle_stage != 'Resolved'")
      .all() as unknown as IncidentRow[];
    return rows.map(rowToIncident);
  }

  loadAllIncidents(): Incident[] {
    const rows = this.db
      .prepare("SELECT * FROM incidents ORDER BY created_at DESC")
      .all() as unknown as IncidentRow[];
    return rows.map(rowToIncident);
  }

  saveIncident(incident: Incident): void {
    this.db
      .prepare(
        `INSERT INTO incidents (incident_id, lifecycle_stage, affected_device_ids, most_probable_root_cause, created_at, timeline, consecutive_healthy_cycles)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(incident_id) DO UPDATE SET
           lifecycle_stage = excluded.lifecycle_stage,
           affected_device_ids = excluded.affected_device_ids,
           most_probable_root_cause = excluded.most_probable_root_cause,
           timeline = excluded.timeline,
           consecutive_healthy_cycles = excluded.consecutive_healthy_cycles`
      )
      .run(
        incident.incident_id,
        incident.lifecycle_stage,
        JSON.stringify(incident.affected_device_ids),
        incident.most_probable_root_cause ?? null,
        incident.created_at,
        JSON.stringify(incident.timeline),
        incident.consecutive_healthy_cycles
      );
  }

  // ---- Discovered hosts (discovery-adapter.ts, prototype phase).
  // saveDiscoveredHosts is an upsert that deliberately never touches
  // added_at in its UPDATE clause - the scheduler calls this after
  // every sweep with plain DiscoveredHost[] (no added_at knowledge at
  // all), and a naive full-column upsert would silently wipe out
  // "already added" status set by markDiscoveredHostAdded on every
  // single sweep. No delete-not-in-set here (unlike
  // savePendingUnmonitoredDevices above) - mergeDiscoveredHosts
  // already carries forward everything it's ever seen, so the array
  // passed in here IS the complete, ever-growing set on purpose. ----

  loadDiscoveredHosts(): DiscoveredHostRecord[] {
    const rows = this.db.prepare("SELECT * FROM discovered_host ORDER BY last_seen DESC").all() as Array<{
      host_key: string;
      ip: string;
      mac: string | null;
      vendor_guess: string | null;
      first_seen: string;
      last_seen: string;
      added_at: string | null;
    }>;
    return rows.map((row) => ({
      ip: row.ip,
      mac: row.mac ?? undefined,
      vendor_guess: row.vendor_guess ?? undefined,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      added_at: row.added_at ?? undefined,
    }));
  }

  saveDiscoveredHosts(hosts: DiscoveredHostRecord[]): void {
    const upsert = this.db.prepare(
      `INSERT INTO discovered_host (host_key, ip, mac, vendor_guess, first_seen, last_seen, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(host_key) DO UPDATE SET
         ip = excluded.ip,
         mac = excluded.mac,
         vendor_guess = excluded.vendor_guess,
         first_seen = excluded.first_seen,
         last_seen = excluded.last_seen`
    );
    for (const h of hosts) {
      upsert.run(hostKey(h), h.ip, h.mac ?? null, h.vendor_guess ?? null, h.first_seen, h.last_seen, h.added_at ?? null);
    }
  }

  markDiscoveredHostAdded(key: string, addedAt: string): void {
    this.db.prepare("UPDATE discovered_host SET added_at = ? WHERE host_key = ?").run(addedAt, key);
  }

  // ---- Pending unmonitored-device records (MVP-only stopgap - see
  // unmonitored-device-job.ts). Full replace-set semantics, not
  // per-row upsert like the tables above: self-clearing means a MAC
  // can leave the pending set entirely between runs, so this deletes
  // anything not in the new set before upserting the rest, atomically. ----

  loadPendingUnmonitoredDevices(): PendingDeviceRecord[] {
    const rows = this.db.prepare("SELECT * FROM unmonitored_device").all() as Array<{
      mac: string;
      vlan: string | null;
      label: string | null;
      first_detected_at: string;
      times_seen: number;
      notified_at: string | null;
      reminder_sent_at: string | null;
    }>;
    return rows.map((row) => ({
      mac: row.mac,
      vlan: row.vlan ?? undefined,
      label: row.label ?? undefined,
      first_detected_at: row.first_detected_at,
      times_seen: row.times_seen,
      notified_at: row.notified_at ?? undefined,
      reminder_sent_at: row.reminder_sent_at ?? undefined,
    }));
  }

  savePendingUnmonitoredDevices(records: PendingDeviceRecord[]): void {
    this.db.exec("BEGIN");
    try {
      if (records.length > 0) {
        const placeholders = records.map(() => "?").join(",");
        this.db
          .prepare(`DELETE FROM unmonitored_device WHERE mac NOT IN (${placeholders})`)
          .run(...records.map((r) => r.mac));
      } else {
        this.db.exec("DELETE FROM unmonitored_device");
      }

      const upsert = this.db.prepare(
        `INSERT INTO unmonitored_device (mac, vlan, label, first_detected_at, times_seen, notified_at, reminder_sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(mac) DO UPDATE SET
           vlan = excluded.vlan,
           label = excluded.label,
           times_seen = excluded.times_seen,
           notified_at = excluded.notified_at,
           reminder_sent_at = excluded.reminder_sent_at`
      );
      for (const r of records) {
        upsert.run(
          r.mac,
          r.vlan ?? null,
          r.label ?? null,
          r.first_detected_at,
          r.times_seen,
          r.notified_at ?? null,
          r.reminder_sent_at ?? null
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // ---- Durable notification outbox (MVP-only stopgap). Store-and-
  // forward without a real backend to wait for: a notification is
  // queued here immediately, and mailer.ts retries delivery on its
  // own schedule until it succeeds - the durability comes from this
  // table surviving a restart, not from waiting on backend contact
  // that doesn't exist for MVP (v0.9 spec §4.2/§8's "dial home"). ----

  enqueueNotification(recipient: string, subject: string, body: string): void {
    this.db
      .prepare(`INSERT INTO notification_queue (recipient, subject, body, created_at, attempts) VALUES (?, ?, ?, ?, 0)`)
      .run(recipient, subject, body, new Date().toISOString());
  }

  loadUnsentNotifications(): QueuedNotification[] {
    const rows = this.db
      .prepare("SELECT * FROM notification_queue WHERE sent_at IS NULL ORDER BY created_at ASC")
      .all() as Array<{
      id: number;
      recipient: string;
      subject: string;
      body: string;
      created_at: string;
      sent_at: string | null;
      attempts: number;
    }>;
    return rows.map((row) => ({ ...row, sent_at: row.sent_at ?? undefined }));
  }

  markNotificationSent(id: number): void {
    this.db.prepare("UPDATE notification_queue SET sent_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  incrementNotificationAttempt(id: number): void {
    this.db.prepare("UPDATE notification_queue SET attempts = attempts + 1 WHERE id = ?").run(id);
  }
}

export interface QueuedNotification {
  id: number;
  recipient: string;
  subject: string;
  body: string;
  created_at: string;
  sent_at?: string;
  attempts: number;
}

function rowToStateRecord(row: {
  device_id: string;
  state: string;
  confidence: string;
  since: string;
  explanation: string | null;
}): DeviceStateRecord {
  return {
    device_id: row.device_id,
    state: row.state as DeviceStateRecord["state"],
    confidence: row.confidence as DeviceStateRecord["confidence"],
    since: row.since,
    explanation: row.explanation ? (JSON.parse(row.explanation) as StateExplanation) : undefined,
  };
}

interface IncidentRow {
  incident_id: string;
  lifecycle_stage: string;
  affected_device_ids: string;
  most_probable_root_cause: string | null;
  created_at: string;
  timeline: string;
  consecutive_healthy_cycles: number;
}

function rowToIncident(row: IncidentRow): Incident {
  return {
    incident_id: row.incident_id,
    lifecycle_stage: row.lifecycle_stage as Incident["lifecycle_stage"],
    affected_device_ids: JSON.parse(row.affected_device_ids),
    most_probable_root_cause: row.most_probable_root_cause ?? undefined,
    created_at: row.created_at,
    timeline: JSON.parse(row.timeline),
    consecutive_healthy_cycles: row.consecutive_healthy_cycles,
  };
}
