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
import type { Device, DeviceStateRecord, StateTransitionEvent } from "./domain-model";
import type { Incident } from "./incident-engine";

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

export class RackWatchWsServer {
  private wss: WebSocketServer;
  private site: SiteInfo = { name: "", config_label: "" };
  private pollIntervalMs = 0;
  private latestPolledAt: string | null = null;
  private devices: DeviceSummary[] = [];
  private latestStates = new Map<string, DeviceStateRecord>();
  private latestIncidents: Incident[] = [];

  constructor(port: number) {
    this.wss = new WebSocketServer({ port });
    this.wss.on("connection", (socket) => this.handleConnection(socket));
    this.wss.on("listening", () => console.log(`[ws-server] listening on ws://localhost:${port}`));
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
