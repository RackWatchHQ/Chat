// ============================================================
// RackWatch Server Entrypoint — Build 1
// ============================================================
//
// Wires the pieces together: loads seed config, opens the SQLite
// store, starts the WebSocket server, then starts the scheduler
// so it starts polling and pushing updates. Run with `npm run dev`
// (auto-restart on change) or `npm run build && npm start`.
// ============================================================

import path from "node:path";
import { RackWatchStore } from "./persistence";
import { RackWatchWsServer } from "./ws-server";
import { CheckScheduler } from "./scheduler";
import { createDiscoveryScheduler } from "./discovery-scheduler";
import { buildDeviceConfigSnippet, hostKey } from "./discovery-adapter";
import { devices, checks, dependencies, integrations, siteInfo, monitoringInterfaceNames } from "./config";

const WS_PORT = Number(process.env.RACKWATCH_WS_PORT ?? 8080);
const TICK_INTERVAL_MS = Number(process.env.RACKWATCH_TICK_MS ?? 10_000);
const DB_PATH = process.env.RACKWATCH_DB_PATH ?? path.join(__dirname, "..", "data", "rackwatch.sqlite");

// Required, not optional with an insecure fallback - a WS command
// channel (sweep_now, add_device) with no gate at all was the whole
// problem being closed here. Same secret must be set in the frontend
// build as VITE_RACKWATCH_WS_TOKEN (switch-dashboard.jsx and
// discovery-view.jsx both connect to this same server/port).
const RAW_WS_TOKEN = process.env.RACKWATCH_WS_TOKEN;
if (!RAW_WS_TOKEN) {
  console.error("[server] RACKWATCH_WS_TOKEN is not set - refusing to start with an unauthenticated WS command channel.");
  console.error("[server] Set it to any shared secret, and set the SAME value as VITE_RACKWATCH_WS_TOKEN when building the frontend.");
  process.exit(1);
}
// TS can't narrow a module-level const across the closure boundary
// into main() below - re-bind to a definitely-string local instead of
// asserting with `!` at every call site.
const WS_TOKEN: string = RAW_WS_TOKEN;

function main(): void {
  const store = new RackWatchStore(DB_PATH);
  console.log(`[server] SQLite store at ${DB_PATH}`);

  const wsServer = new RackWatchWsServer(WS_PORT, WS_TOKEN);
  // Seed the WS server with whatever was already persisted, so a client
  // connecting before the first poll cycle completes still sees the
  // last known state rather than an empty dashboard.
  wsServer.seed(siteInfo, TICK_INTERVAL_MS, devices, store.loadAllDisplayedStates(), store.loadAllIncidents());
  wsServer.seedDiscovery(store.loadDiscoveredHosts());

  // ---- Discovery (prototype phase) - see docs/discovery-adapter-scope.md.
  // Separate from CheckScheduler above on purpose: sweeps subnets, not
  // Devices/Checks, and runs on its own 30-minute clock. ----
  const discoveryScheduler = createDiscoveryScheduler({
    sweepConfig: { monitoringInterfaceNames },
    loadPreviousHosts: () => store.loadDiscoveredHosts(),
    onSweepComplete: (hosts) => {
      store.saveDiscoveredHosts(hosts);
      // Re-load rather than broadcast `hosts` directly - saveDiscoveredHosts
      // deliberately never touches added_at, so the persisted rows (which
      // may carry added_at set by an add_device command below) are the
      // authoritative view, not the plain DiscoveredHost[] the sweep itself produced.
      wsServer.broadcastDiscoveryUpdate(store.loadDiscoveredHosts());
    },
  });

  wsServer.onCommand((command) => {
    if (command.type === "sweep_now") {
      void discoveryScheduler.sweepNow();
      return;
    }
    if (command.type === "add_device") {
      const host = store.loadDiscoveredHosts().find((h) => hostKey(h) === command.host_key);
      if (!host) {
        console.warn(`[server] add_device: no discovered host found for key ${command.host_key}`);
        return;
      }
      console.log(`[server] add-as-monitored-device requested for ${command.host_key}:\n${buildDeviceConfigSnippet(host)}`);
      store.markDiscoveredHostAdded(command.host_key, new Date().toISOString());
      wsServer.broadcastDiscoveryUpdate(store.loadDiscoveredHosts());
    }
  });

  discoveryScheduler.start();

  const scheduler = new CheckScheduler({
    devices,
    checks,
    dependencies,
    integrations,
    store,
    tickIntervalMs: TICK_INTERVAL_MS,
    onCycleComplete: ({ displayedStates, transitionEvents, incidents, polledAt }) => {
      if (transitionEvents.length > 0) {
        for (const event of transitionEvents) {
          console.log(`[scheduler] ${event.device_id}: ${event.from_state} -> ${event.to_state} (${event.reason})`);
        }
      }
      wsServer.broadcastUpdate(displayedStates, transitionEvents, incidents, polledAt);
    },
  });

  scheduler.start();
  console.log(`[server] scheduler started, tick interval ${TICK_INTERVAL_MS}ms`);

  const shutdown = () => {
    console.log("\n[server] shutting down");
    scheduler.stop();
    discoveryScheduler.stop();
    void wsServer.close().finally(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
