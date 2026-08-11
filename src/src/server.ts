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
import { devices, checks, dependencies, integrations, siteInfo } from "./config";

const WS_PORT = Number(process.env.RACKWATCH_WS_PORT ?? 8080);
const TICK_INTERVAL_MS = Number(process.env.RACKWATCH_TICK_MS ?? 10_000);
const DB_PATH = process.env.RACKWATCH_DB_PATH ?? path.join(__dirname, "..", "data", "rackwatch.sqlite");

function main(): void {
  const store = new RackWatchStore(DB_PATH);
  console.log(`[server] SQLite store at ${DB_PATH}`);

  const wsServer = new RackWatchWsServer(WS_PORT);
  // Seed the WS server with whatever was already persisted, so a client
  // connecting before the first poll cycle completes still sees the
  // last known state rather than an empty dashboard.
  wsServer.seed(siteInfo, TICK_INTERVAL_MS, devices, store.loadAllDisplayedStates(), store.loadAllIncidents());

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
    void wsServer.close().finally(() => {
      store.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
