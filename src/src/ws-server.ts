// ============================================================
// WebSocket Server — Build 1
// ============================================================
//
// Pushes state to the frontend; the frontend never polls. On
// connect, a client gets a full snapshot of current displayed
// state + open incidents. After that, it gets one "update" message
// per completed poll cycle (see scheduler.ts) - only what changed
// that cycle, plus the current full incident list (incidents are
// few enough that resending the list is simpler than diffing it,
// and IE-005 already guarantees Resolved ones stop changing).
// ============================================================

import { WebSocketServer, WebSocket } from "ws";
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Device, DeviceStateRecord, StateTransitionEvent } from "./domain-model";
import type { Incident } from "./incident-engine";
import type { DiscoveredHostRecord } from "./discovery-adapter";

// Slim, display-only projection of Device - the frontend needs a name
// and role to show something meaningful next to a device_id, but has
// no business seeing checks/adapter_refs (integration credentials live
// in Integration.config, which this never touches, but there's no
// reason to hand over the full Device shape either). dashboard_column/
// dashboard_group come from Device.metadata (DM-009's "controlled
// extensible attributes") - see config.ts for the convention.
export interface DeviceSummary {
  device_id: string;
  name: string;
  type: string;
  operational_role: string;
  operational_system: string;
  dashboard_column?: string;
  dashboard_group?: string;
}

export interface SiteInfo {
  name: string;
  config_label: string;
}

function toDeviceSummary(device: Device): DeviceSummary {
  const column = device.metadata.dashboard_column;
  const group = device.metadata.dashboard_group;
  return {
    device_id: device.device_id,
    name: device.name,
    type: device.type,
    operational_role: device.operational_role,
    operational_system: device.operational_system,
    dashboard_column: typeof column === "string" ? column : undefined,
    dashboard_group: typeof group === "string" ? group : undefined,
  };
}

export interface SnapshotMessage {
  type: "snapshot";
  site: SiteInfo;
  pollIntervalMs: number;
  polledAt: string | null; // null until this server process has completed at least one poll cycle
  devices: DeviceSummary[];
  states: DeviceStateRecord[];
  incidents: Incident[];
}

export interface UpdateMessage {
  type: "update";
  polledAt: string;
  states: DeviceStateRecord[]; // full current displayed state for every device
  transitionEvents: StateTransitionEvent[]; // only this cycle's new transitions
  incidents: Incident[];
}

// ---- Discovery messages (discovery-adapter.ts, prototype phase) ----
// Sent to every connected client alongside the messages above, not on
// a separate connection/port - the kiosk dashboard (switch-dashboard.jsx)
// simply ignores message types it doesn't recognise, same as it always
// has for any future message type. The discovery results view (a
// separate frontend entry point) is what actually acts on these.

export interface DiscoverySnapshotMessage {
  type: "discovery_snapshot";
  hosts: DiscoveredHostRecord[];
}

export interface DiscoveryUpdateMessage {
  type: "discovery_update";
  hosts: DiscoveredHostRecord[];
}

// ---- Incoming commands ----
// The first messages this server has ever needed to RECEIVE, not just
// send - everything before this was push-only. Validated with a type
// guard rather than trusted as-is (DM-002: never guess at
// unrecognised/malformed input) since this is now a real input
// boundary, unlike every other message in this file.

export type IncomingCommand = { type: "sweep_now" } | { type: "add_device"; host_key: string };

function isIncomingCommand(value: unknown): value is IncomingCommand {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  const v = value as { type: unknown };
  if (v.type === "sweep_now") return true;
  if (v.type === "add_device") return typeof (value as { host_key?: unknown }).host_key === "string";
  return false;
}

// ---- Connection auth (closes the WS-command open-door gap) ----
// Rejected at the WebSocket HANDSHAKE (verifyClient), not per-message
// after accepting the connection - a wrong/missing token never gets
// as far as a "connection" event at all. Browser WebSocket can't set
// custom headers, so the token travels as a query param - the only
// mechanism actually available to a browser client. No IP/origin
// restriction - the discovery view must work from a different machine
// on the same network (already ruled out loopback-only earlier), so
// the token is the ONLY gate, deliberately.
//
// This is "closing an open door," not a login system: one shared
// value, checked at connect time. It's baked into each frontend's
// build (VITE_RACKWATCH_WS_TOKEN), so it's only as secret as the
// served JS bundle - keeps a random device on the network out, not a
// determined attacker with real access to the frontend.

function extractToken(requestUrl: string | undefined): string {
  if (!requestUrl) return "";
  try {
    return new URL(requestUrl, "http://placeholder").searchParams.get("token") ?? "";
  } catch {
    return "";
  }
}

function tokensMatch(provided: string, expected: string): boolean {
  const providedBuf = Buffer.from(provided);
  const expectedBuf = Buffer.from(expected);
  // timingSafeEqual throws on unequal-length buffers rather than
  // returning false - length itself is a coarse enough signal that
  // this early return isn't a meaningful timing leak for what this
  // gate is actually defending against (see file header).
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}

export class RackWatchWsServer {
  private wss: WebSocketServer;
  private site: SiteInfo = { name: "", config_label: "" };
  private pollIntervalMs = 0;
  private latestPolledAt: string | null = null;
  private devices: DeviceSummary[] = [];
  private latestStates = new Map<string, DeviceStateRecord>();
  private latestIncidents: Incident[] = [];
  private discoveredHosts: DiscoveredHostRecord[] = [];
  private commandHandler: ((command: IncomingCommand) => void) | undefined;

  constructor(port: number, token: string) {
    this.wss = new WebSocketServer({
      port,
      verifyClient: (info: { origin: string; secure: boolean; req: IncomingMessage }) =>
        tokensMatch(extractToken(info.req.url), token),
    });
    this.wss.on("connection", (socket) => this.handleConnection(socket));
    this.wss.on("listening", () => console.log(`[ws-server] listening on ws://localhost:${port}`));
  }

  // Registers the one handler for incoming commands - wired up in
  // server.ts, same separation as onCycleComplete in scheduler.ts.
  // This file stays a thin message-passing layer; it doesn't know
  // about discovery-scheduler.ts or persistence.ts itself.
  onCommand(handler: (command: IncomingCommand) => void): void {
    this.commandHandler = handler;
  }

  seedDiscovery(hosts: DiscoveredHostRecord[]): void {
    this.discoveredHosts = hosts;
  }

  broadcastDiscoveryUpdate(hosts: DiscoveredHostRecord[]): void {
    this.discoveredHosts = hosts;
    const message: DiscoveryUpdateMessage = { type: "discovery_update", hosts };
    const payload = JSON.stringify(message);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  // ---- Called once at startup with static site/device config plus
  // whatever state was already persisted, so the very first client
  // connection doesn't see an empty dashboard before the first poll
  // cycle completes. ----
  seed(
    site: SiteInfo,
    pollIntervalMs: number,
    devices: Device[],
    states: Map<string, DeviceStateRecord>,
    incidents: Incident[]
  ): void {
    this.site = site;
    this.pollIntervalMs = pollIntervalMs;
    this.devices = devices.map(toDeviceSummary);
    this.latestStates = states;
    this.latestIncidents = incidents;
  }

  private handleConnection(socket: WebSocket): void {
    const snapshot: SnapshotMessage = {
      type: "snapshot",
      site: this.site,
      pollIntervalMs: this.pollIntervalMs,
      polledAt: this.latestPolledAt,
      devices: this.devices,
      states: Array.from(this.latestStates.values()),
      incidents: this.latestIncidents,
    };
    socket.send(JSON.stringify(snapshot));

    const discoverySnapshot: DiscoverySnapshotMessage = { type: "discovery_snapshot", hosts: this.discoveredHosts };
    socket.send(JSON.stringify(discoverySnapshot));

    socket.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return; // malformed payload - ignore rather than crash the connection
      }
      if (isIncomingCommand(parsed)) {
        this.commandHandler?.(parsed);
      }
    });
  }

  broadcastUpdate(
    states: Map<string, DeviceStateRecord>,
    transitionEvents: StateTransitionEvent[],
    incidents: Incident[],
    polledAt: string
  ): void {
    this.latestStates = states;
    this.latestIncidents = incidents;
    this.latestPolledAt = polledAt;

    const message: UpdateMessage = {
      type: "update",
      polledAt,
      states: Array.from(states.values()),
      transitionEvents,
      incidents,
    };
    const payload = JSON.stringify(message);

    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
