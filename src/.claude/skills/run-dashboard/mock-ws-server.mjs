#!/usr/bin/env node
// Mock RackWatch WebSocket server for dashboard UI verification.
//
// Sends a canned SnapshotMessage (see ../../../src/ws-server.ts for the
// real shapes) to every connection - no scheduler, no real devices.
// The real backend needs 60-90s of poll cycles against reachable
// network hardware before any interesting state (Critical/incidents)
// appears, which isn't practical for a quick UI check.
//
// Usage: node mock-ws-server.mjs [fixture.json]
//   fixture.json defaults to fixtures/fault-scenario.json - must
//   contain { site, pollIntervalMs, devices, states, incidents }
//   (SnapshotMessage minus "type" and "polledAt", which this script
//   fills in itself on every connection).

import { WebSocketServer } from "ws";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.RACKWATCH_MOCK_WS_PORT ?? 8080);

const fixturePath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(__dirname, "fixtures", "fault-scenario.json");

const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (socket) => {
  const snapshot = {
    type: "snapshot",
    polledAt: new Date().toISOString(),
    ...fixture,
  };
  socket.send(JSON.stringify(snapshot));
});

wss.on("listening", () => {
  console.log(`[mock-ws] listening on ws://localhost:${PORT}`);
  console.log(`[mock-ws] fixture: ${fixturePath}`);
});

wss.on("error", (err) => {
  console.error("[mock-ws] server error:", err.message);
  process.exit(1);
});
