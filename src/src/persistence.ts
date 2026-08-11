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
import type { DeviceEvidenceWindow } from "./state-engine";
import type { Incident } from "./incident-engine";

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

CREATE TABLE IF NOT EXISTS incidents (
  incident_id TEXT PRIMARY KEY,
  lifecycle_stage TEXT NOT NULL,
  affected_device_ids TEXT NOT NULL,
  most_probable_root_cause TEXT,
  created_at TEXT NOT NULL,
  timeline TEXT NOT NULL,
  consecutive_healthy_cycles INTEGER NOT NULL
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
