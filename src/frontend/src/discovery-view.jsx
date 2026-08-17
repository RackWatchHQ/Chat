// ============================================================
// Discovery Results View — Prototype Phase
// ============================================================
//
// Internal ops tooling, not the client-facing kiosk display -
// switch-dashboard.jsx stays untouched. Deliberately minimal per
// docs/discovery-adapter-scope.md §4: a plain list (IP, MAC, vendor
// guess, first/last seen) with a manual "sweep now" trigger and a
// manual "add as monitored device" action per row. No classification
// workflow, no auto-matching to adapter types - that's parked as
// later Config UI work, not built here.
//
// "Add as monitored device" does NOT make the device live - config.ts
// is a static file read once at process start, there's no runtime-
// mutable Device store to insert into yet. The button logs a ready-
// to-paste Device config snippet on the SERVER (see server.ts's
// add_device command handler) and marks the row so it's visually
// distinct here - a human still copies the snippet into config.ts
// and restarts.
// ============================================================

import { useEffect, useMemo, useState } from "react";

const DEFAULT_WS_URL = import.meta.env.VITE_RACKWATCH_WS_URL ?? "ws://localhost:8080";
const MAX_RECONNECT_DELAY_MS = 15_000;

// Baked in at build time (VITE_RACKWATCH_WS_TOKEN) - the server
// rejects the connection at handshake if this doesn't match
// RACKWATCH_WS_TOKEN (see ws-server.ts). Browser WebSocket can't set
// custom headers, so this travels as a query param.
const WS_TOKEN = import.meta.env.VITE_RACKWATCH_WS_TOKEN ?? "";

function withAuthToken(url) {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}token=${encodeURIComponent(WS_TOKEN)}`;
}

function hostKey(host) {
  return host.mac ?? host.ip;
}

function formatTime(iso) {
  return new Date(iso).toLocaleString();
}

// ---- WebSocket connection - same reconnect-with-backoff shape
// useRackWatchSocket already uses in switch-dashboard.jsx, listening
// for discovery_snapshot/discovery_update instead of snapshot/update,
// and able to SEND commands (sweep_now, add_device) - the first
// two-way use of this connection anywhere in the frontend.

function useDiscoverySocket(url) {
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const [hosts, setHosts] = useState([]);
  const [socket, setSocket] = useState(null);

  useEffect(() => {
    let ws;
    let cancelled = false;
    let reconnectAttempt = 0;
    let reconnectTimer = null;

    function connect() {
      setConnectionStatus("connecting");
      ws = new WebSocket(withAuthToken(url));

      ws.onopen = () => {
        if (cancelled) return;
        reconnectAttempt = 0;
        setConnectionStatus("open");
        setSocket(ws);
      };

      ws.onmessage = (event) => {
        if (cancelled) return;
        const message = JSON.parse(event.data);
        if (message.type === "discovery_snapshot" || message.type === "discovery_update") {
          setHosts(message.hosts);
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        setConnectionStatus("closed");
        setSocket(null);
        const delay = Math.min(1000 * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY_MS);
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };

      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    };
  }, [url]);

  function send(command) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(command));
  }

  return {
    connectionStatus,
    hosts,
    sweepNow: () => send({ type: "sweep_now" }),
    addDevice: (key) => send({ type: "add_device", host_key: key }),
  };
}

export default function DiscoveryView({ wsUrl = DEFAULT_WS_URL }) {
  const { connectionStatus, hosts, sweepNow, addDevice } = useDiscoverySocket(wsUrl);

  const sorted = useMemo(
    () => [...hosts].sort((a, b) => new Date(b.last_seen).getTime() - new Date(a.last_seen).getTime()),
    [hosts]
  );

  return (
    <div style={{ fontFamily: "system-ui, -apple-system, sans-serif", padding: 24, maxWidth: 960, margin: "0 auto", color: "#1a1a1a" }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>RackWatch — Discovered Hosts</h1>
          <p style={{ fontSize: 12, color: "#666", margin: "4px 0 0" }}>Prototype phase - see docs/discovery-adapter-scope.md</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span data-status={connectionStatus} style={{ fontSize: 12, color: connectionStatus === "open" ? "#1a7f37" : "#b35900" }}>
            {connectionStatus}
          </span>
          <button onClick={sweepNow} disabled={connectionStatus !== "open"}>
            Sweep now
          </button>
        </div>
      </header>

      {sorted.length === 0 ? (
        <p style={{ color: "#666" }}>{connectionStatus === "open" ? "No hosts discovered yet." : "Connecting…"}</p>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "2px solid #ddd" }}>
              <th style={{ padding: "6px 8px" }}>IP</th>
              <th style={{ padding: "6px 8px" }}>MAC</th>
              <th style={{ padding: "6px 8px" }}>Vendor guess</th>
              <th style={{ padding: "6px 8px" }}>First seen</th>
              <th style={{ padding: "6px 8px" }}>Last seen</th>
              <th style={{ padding: "6px 8px" }} />
            </tr>
          </thead>
          <tbody>
            {sorted.map((host) => (
              <tr key={hostKey(host)} style={{ borderBottom: "1px solid #eee", opacity: host.added_at ? 0.5 : 1 }}>
                <td style={{ padding: "6px 8px" }}>{host.ip}</td>
                <td style={{ padding: "6px 8px", fontVariantNumeric: "tabular-nums" }}>{host.mac ?? "—"}</td>
                <td style={{ padding: "6px 8px" }}>{host.vendor_guess ?? "—"}</td>
                <td style={{ padding: "6px 8px" }}>{formatTime(host.first_seen)}</td>
                <td style={{ padding: "6px 8px" }}>{formatTime(host.last_seen)}</td>
                <td style={{ padding: "6px 8px", textAlign: "right" }}>
                  {host.added_at ? (
                    <span style={{ fontSize: 12, color: "#888" }}>Added {formatTime(host.added_at)}</span>
                  ) : (
                    <button onClick={() => addDevice(hostKey(host))}>Add as monitored device</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
