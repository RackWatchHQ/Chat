---
name: run-dashboard
description: Build, run, and screenshot the RackWatch kiosk dashboard (src/frontend). Use when asked to start the dashboard, take a screenshot of it, verify a UI change to switch-dashboard.jsx, or check the banner/incident/device-row rendering against mock WebSocket data.
---

Drives the dashboard (a Vite dev server) with a real, system-installed
Chrome via `playwright-core` and a mock WebSocket fixture server - no
real backend, no real network devices, no 60-90s wait for the
scheduler to produce interesting state. Handle: `driver.mjs` in this
directory, fed by `mock-ws-server.mjs`.

All paths below are relative to `src/` (this skill lives at
`src/.claude/skills/run-dashboard/`).

## Prerequisites

None beyond what the repo already needs (Node.js) - no OS packages
were required in this container. `driver.mjs` reuses a locally
installed Google Chrome via Playwright's `channel: "chrome"`, so no
browser download is needed either. Verified present at
`/Applications/Google Chrome.app` (macOS); on Linux, install Chrome
(or point `channel` at `"chromium"`) if it isn't already there.

## Setup

One-time, inside this skill directory:

```bash
cd src/.claude/skills/run-dashboard
npm install
```

This installs `playwright-core` (driver library only - not the full
`playwright` package, so it does **not** try to download a bundled
Chromium; it drives the OS's existing Chrome instead) and `ws` (for
the mock server). These are skill-local dependencies, deliberately
separate from `src/package.json` and `src/frontend/package.json` -
they're agent tooling, not app dependencies.

No separate build step - `npm run dev` (below) runs Vite directly
against the frontend source.

## Run (agent path)

Needs two background processes on two ports, then the driver:

| What | Port | Why |
|---|---|---|
| `mock-ws-server.mjs` | 8080 | Fakes `src/ws-server.ts` - sends a canned `SnapshotMessage` fixture instead of real scheduler output |
| `vite` (`src/frontend`) | 5173 | The actual dashboard dev server |

**0. Free both ports first** (safe to run even if nothing's listening;
also how you clean up when done):

```bash
lsof -ti:8080 -sTCP:LISTEN | xargs -r kill
lsof -ti:5173 -sTCP:LISTEN | xargs -r kill
sleep 1
```

**1. Start the mock WebSocket server**, pointed at a fixture:

```bash
cd src/.claude/skills/run-dashboard
node mock-ws-server.mjs fixtures/fault-scenario.json > /tmp/mock-ws.log 2>&1 &
sleep 1
cat /tmp/mock-ws.log   # expect: "[mock-ws] listening on ws://localhost:8080"
```

Omit the fixture argument to get `fixtures/fault-scenario.json` by
default. `fixtures/healthy-scenario.json` is also included (no open
incidents, all devices Healthy) - swap between them by killing the
mock server (`lsof -ti:8080 -sTCP:LISTEN | xargs -r kill`) and
restarting with a different fixture path; no need to restart Vite.

**Fixture shape** (a `SnapshotMessage` minus `type` and `polledAt`,
which the mock server fills in on every connection - see
`../../../src/ws-server.ts` for the authoritative types):

```jsonc
{
  "site": { "name": "...", "config_label": "..." },
  "pollIntervalMs": 30000,
  "devices": [ // DeviceSummary[]
    { "device_id": "...", "name": "...", "type": "...", "operational_role": "...",
      "operational_system": "...", "dashboard_column": "...", "dashboard_group": "..." }
  ],
  "states": [ // DeviceStateRecord[]
    { "device_id": "...", "state": "Healthy" | "Degraded" | "Critical" | "Unknown" | "Dependency",
      "confidence": "High" | "Moderate" | "Low", "since": "...", "explanation": { /* optional */ } }
  ],
  "incidents": [ // Incident[]
    { "incident_id": "...", "lifecycle_stage": "Detected" | "Correlating" | "Active" | "Recovering" | "Resolved",
      "affected_device_ids": ["..."], "most_probable_root_cause": "<a device_id>",
      "created_at": "...", "timeline": [], "consecutive_healthy_cycles": 0 }
  ]
}
```

**2. Start the Vite dev server**, polling for readiness instead of a
fixed sleep:

```bash
cd src/frontend
nohup npm run dev > /tmp/vite-dev.log 2>&1 &
i=0; until curl -sf http://localhost:5173 >/dev/null 2>&1 || [ $i -ge 30 ]; do sleep 1; i=$((i+1)); done
curl -sf http://localhost:5173 >/dev/null 2>&1 && echo "vite up after ${i}s" || cat /tmp/vite-dev.log
```

**3. Run the driver** - navigates, waits for the banner to render,
screenshots, and dumps extracted text for a fast pass/fail check
without opening the image:

```bash
cd src/.claude/skills/run-dashboard
node driver.mjs http://localhost:5173 /tmp/dashboard.png
```

```
=== banner text ===
ATTENTION REQUIRED

TEST SITE

Core Switch A Offline · +2 more affected
=== columns text ===
INFRASTRUCTURE
SWITCHES
Core Switch A
Offline
Access Switch B
Access Switch C
CAMERAS
Camera 1
=== console errors ===
(none)
=== screenshot ===
/tmp/dashboard.png
```

Exits non-zero if the page threw any console errors. Screenshot lands
wherever you point the second argument (default `./screenshot.png` in
cwd if omitted).

**4. Clean up** - same command as step 0:

```bash
lsof -ti:8080 -sTCP:LISTEN | xargs -r kill
lsof -ti:5173 -sTCP:LISTEN | xargs -r kill
```

## Run (human path)

```bash
cd src/frontend && npm run dev   # → http://localhost:5173, Ctrl-C to stop
```

Needs a real WebSocket server on `ws://localhost:8080` to show
anything - either the mock server above, or the real backend
(`cd src && npm run dev`, which needs reachable network devices in
`src/config.ts` before any fault state appears). Override the socket
URL with `VITE_RACKWATCH_WS_URL` if not using the default port.

## Test

No test suite for the frontend yet (`src/frontend/package.json` has no
`test` script). `npm run lint` (`oxlint`) and `npm run build` (`vite
build`) both pass as of this writing.

---

## Gotchas

- **`chromium-cli` was not available in this environment.** Fell back
  to `playwright-core` (driver library only, no bundled browser) with
  `channel: "chrome"` to drive the OS's already-installed Chrome
  instead of downloading one. If `chromium-cli` **is** available where
  you're running this, prefer it over `driver.mjs` - it's the
  house-standard harness; this driver exists because that wasn't an
  option here.
- **Don't `npm install playwright`** (the full package) - it tries to
  download a bundled Chromium on install, which is unnecessary (and
  may fail/hang without network egress to the download host) when a
  system Chrome is already present. `playwright-core` alone plus
  `channel: "chrome"` avoids that entirely.
- **The real backend can't be used for a quick UI check.** `src/`'s
  own scheduler needs real, reachable network devices and 60-90s of
  poll cycles (3 consecutive failures at a 30s check interval) before
  a device goes Critical and an incident opens. The mock server exists
  specifically to skip that wait.
- **No `timeout` command on macOS by default** - the readiness-poll
  loops above use a manual `until ... || [ $i -ge N ]` counter instead
  of wrapping with `timeout N`, which isn't installed on stock macOS.
- **`$!` after `npm run dev &` is only the npm wrapper**, not the Vite
  process npm spawns - `kill $!` won't reliably free port 5173. Kill by
  port (`lsof -ti:5173 -sTCP:LISTEN | xargs -r kill`) instead, as
  above.

## Troubleshooting

- **`driver.mjs` hangs on `page.waitForSelector(".banner")`**: almost
  always means the mock WS server isn't running or is on the wrong
  port - check `/tmp/mock-ws.log`, and confirm `useRackWatchSocket` in
  `switch-dashboard.jsx` is pointed at `ws://localhost:8080` (the
  default; override via `VITE_RACKWATCH_WS_URL` if you changed it).
- **`Error: browserType.launch: executable doesn't exist`** (from
  `playwright-core` with `channel: "chrome"`): no system Chrome found.
  Install Google Chrome, or edit `driver.mjs` to use
  `channel: "chromium"` / a full `playwright` install instead.
- **Port already in use / `EADDRINUSE`**: a previous run's process is
  still listening. Run the step-0 `lsof -ti:PORT -sTCP:LISTEN | xargs
  -r kill` commands before retrying.
