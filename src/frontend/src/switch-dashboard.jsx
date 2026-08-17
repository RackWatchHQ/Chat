// ============================================================
// Switch Dashboard — kiosk display
// ============================================================
//
// Pure display component: connects to RackWatch's WebSocket server
// (src/ws-server.ts on the backend) and renders whatever it's told.
// No polling, no local simulation - every state shown here came
// from a real "snapshot" or "update" message. Reconnects with a
// capped backoff if the connection drops.
//
// Design intent (per the kiosk mockup): calm by default. A big
// banner gives the whole-site verdict at a glance; individual rows
// only get color/weight when something actually needs attention.
// One kiosk instance = one site's WebSocket feed.
// ============================================================

import { useEffect, useMemo, useState } from "react";
import "./switch-dashboard.css";

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

// States that warrant "attention" - Dependency and Unknown deliberately
// don't count. A device that's only Dependency is a reflection of an
// upstream fault that's already triggering the banner on its own
// (dependency-evaluator.ts); re-alarming on it here would defeat the
// point of that recast. Unknown just means "no verdict yet."
function needsAttention(state) {
  return state === "Critical" || state === "Degraded";
}

function shortStatusLabel(state) {
  if (state === "Critical") return "Offline";
  if (state === "Degraded") return "Degraded";
  return "";
}

const DOT_COLOR = {
  Healthy: "var(--healthy)",
  Degraded: "var(--warning)",
  Critical: "var(--fault)",
  Unknown: "var(--muted)",
  Dependency: "var(--muted)",
};

// ---- Icons (inline SVG - crisp at any size, no external/emoji font dependency) ----

function CheckCircleIcon() {
  return (
    <svg width="44" height="44" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="var(--healthy)" />
      <path d="M7 12.3l3.2 3.2L17 8.5" stroke="var(--panel)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WarningTriangleIcon({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3.5L22 20.5H2L12 3.5Z" stroke="var(--fault)" strokeWidth="2" strokeLinejoin="round" />
      <line x1="12" y1="9.5" x2="12" y2="14.5" stroke="var(--fault)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="17.3" r="1.1" fill="var(--fault)" />
    </svg>
  );
}

function RowWarningIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12 3.5L22 20.5H2L12 3.5Z" fill="var(--fault)" />
      <line x1="12" y1="9.5" x2="12" y2="14" stroke="var(--panel)" strokeWidth="2" strokeLinecap="round" />
      <circle cx="12" cy="17.1" r="1" fill="var(--panel)" />
    </svg>
  );
}

function ChainIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M9.5 14.5l5-5M8 9.5L5.5 12a3 3 0 004.24 4.24L12 14M16 14.5L18.5 12a3 3 0 00-4.24-4.24L12 10"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ---- WebSocket connection, reconnecting with capped backoff ----

function useRackWatchSocket(url) {
  const [connectionStatus, setConnectionStatus] = useState("connecting");
  const [site, setSite] = useState({ name: "", config_label: "" });
  const [pollIntervalMs, setPollIntervalMs] = useState(0);
  const [devices, setDevices] = useState(new Map());
  const [states, setStates] = useState(new Map());
  const [incidents, setIncidents] = useState([]);
  const [lastPollAt, setLastPollAt] = useState(null);

  useEffect(() => {
    let socket;
    let cancelled = false;
    let reconnectAttempt = 0;
    let reconnectTimer = null;

    function connect() {
      setConnectionStatus("connecting");
      socket = new WebSocket(withAuthToken(url));

      socket.onopen = () => {
        if (cancelled) return;
        reconnectAttempt = 0;
        setConnectionStatus("open");
      };

      socket.onmessage = (event) => {
        if (cancelled) return;
        const message = JSON.parse(event.data);

        if (message.type === "snapshot") {
          setSite(message.site);
          setPollIntervalMs(message.pollIntervalMs);
          setDevices(new Map(message.devices.map((d) => [d.device_id, d])));
          setStates(new Map(message.states.map((s) => [s.device_id, s])));
          setIncidents(message.incidents);
          if (message.polledAt) setLastPollAt(new Date(message.polledAt).getTime());
        } else if (message.type === "update") {
          setStates(new Map(message.states.map((s) => [s.device_id, s])));
          setIncidents(message.incidents);
          setLastPollAt(new Date(message.polledAt).getTime());
        }
      };

      socket.onclose = () => {
        if (cancelled) return;
        setConnectionStatus("closed");
        const delay = Math.min(1000 * 2 ** reconnectAttempt, MAX_RECONNECT_DELAY_MS);
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(connect, delay);
      };

      socket.onerror = () => socket.close();
    }

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket) socket.close();
    };
  }, [url]);

  return { connectionStatus, site, pollIntervalMs, devices, states, incidents, lastPollAt };
}

// ---- Group devices by dashboard_column, then dashboard_group ----
// A device with no dashboard_group renders directly under its column
// heading with no subheading (see config.ts for the convention).

function groupDevices(devices) {
  const columns = new Map(); // column -> Map<group|null, device[]>
  for (const device of devices.values()) {
    const column = device.dashboard_column ?? "Devices";
    const group = device.dashboard_group ?? null;
    if (!columns.has(column)) columns.set(column, new Map());
    const groups = columns.get(column);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(device);
  }
  return columns;
}

// ---- Presentational pieces ----

function DeviceRow({ device, state }) {
  const currentState = state?.state ?? "Unknown";
  const fault = needsAttention(currentState);

  return (
    <div className="device-row">
      <span className="row-dot" style={{ background: DOT_COLOR[currentState] }} aria-hidden="true" />
      <div className="row-text">
        <span className="row-name" style={fault ? { color: DOT_COLOR[currentState] } : undefined}>
          {device.name}
        </span>
        {fault && (
          <span className="row-substatus" style={{ color: DOT_COLOR[currentState] }}>
            {shortStatusLabel(currentState)}
          </span>
        )}
      </div>
      {currentState === "Dependency" && (
        <span className="row-chain" title="Caused by an upstream dependency">
          <ChainIcon />
        </span>
      )}
      {fault && (
        <span className="row-warning" aria-hidden="true">
          <RowWarningIcon />
        </span>
      )}
    </div>
  );
}

function Column({ name, groups, states }) {
  return (
    <div className="kiosk-column">
      <h2 className="column-title">{name}</h2>
      <div className="column-scroll">
        {Array.from(groups.entries()).map(([groupName, groupDevices]) => (
          <div key={groupName ?? "__ungrouped"}>
            {groupName && <h3 className="group-title">{groupName}</h3>}
            {groupDevices.map((device) => (
              <DeviceRow key={device.device_id} device={device} state={states.get(device.device_id)} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// One chip per open Incident (not per affected device) - an incident
// with 4 affected devices is one operational problem with one probable
// root cause, not 4 independent red rows (incident-engine.ts spec 7.1).
function IncidentChip({ incident, devices, states }) {
  const rootId = incident.most_probable_root_cause;
  const rootDevice = rootId ? devices.get(rootId) : undefined;
  const rootState = rootId ? states.get(rootId)?.state : undefined;
  const otherAffectedCount = incident.affected_device_ids.filter((id) => id !== rootId).length;

  return (
    <div className="banner-reason-chip">
      {rootDevice?.name ?? rootId ?? "Unknown device"}{" "}
      {shortStatusLabel(rootState) || incident.lifecycle_stage}
      {otherAffectedCount > 0 && (
        <span className="banner-reason-extra"> · +{otherAffectedCount} more affected</span>
      )}
    </div>
  );
}

function Banner({ ok, siteName, openIncidents, devices, states }) {
  return (
    <div className={`banner ${ok ? "banner-ok" : "banner-fault"}`}>
      <div className="banner-icon">{ok ? <CheckCircleIcon /> : <WarningTriangleIcon />}</div>
      <p className="banner-headline">{ok ? "All Systems Healthy" : "Attention Required"}</p>
      <div className="banner-divider" />
      <p className="banner-site">{siteName}</p>
      {!ok && (
        <div className="banner-reasons">
          {openIncidents.map((incident) => (
            <IncidentChip key={incident.incident_id} incident={incident} devices={devices} states={states} />
          ))}
        </div>
      )}
    </div>
  );
}

function formatClock(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour12: false });
}

function formatRelativeTime(ms, nowMs) {
  const deltaSeconds = Math.max(0, Math.round((nowMs - ms) / 1000));
  if (deltaSeconds < 5) return "just now";
  if (deltaSeconds < 60) return `${deltaSeconds}s ago`;
  const minutes = Math.round(deltaSeconds / 60);
  return `${minutes}m ago`;
}

function Footer({ configLabel, pollIntervalMs, lastPollAt, nowMs }) {
  return (
    <div className="kiosk-footer">
      <p className="footer-section-label">Engineering</p>
      <div className="footer-stats">
        <div className="footer-stat">
          <span className="footer-stat-label">Config</span>
          <span className="footer-stat-value">{configLabel || "—"}</span>
        </div>
        <div className="footer-stat">
          <span className="footer-stat-label">Poll Interval</span>
          <span className="footer-stat-value">
            {pollIntervalMs ? `${Math.round(pollIntervalMs / 1000)} seconds` : "—"}
          </span>
        </div>
        <div className="footer-stat">
          <span className="footer-stat-label">Last Poll</span>
          <span className="footer-stat-value">
            {lastPollAt ? `${formatClock(lastPollAt)} (${formatRelativeTime(lastPollAt, nowMs)})` : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}

// ---- Root component ----

export default function SwitchDashboard({ wsUrl = DEFAULT_WS_URL }) {
  const { connectionStatus, site, pollIntervalMs, devices, states, incidents, lastPollAt } = useRackWatchSocket(wsUrl);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const tick = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(tick);
  }, []);

  const columns = useMemo(() => groupDevices(devices), [devices]);

  // snapshot's incident list is all-time (persistence.ts's loadAllIncidents,
  // for dashboard history use later) - the banner only cares what's still
  // open right now, same convention as persistence.ts's loadOpenIncidents.
  const openIncidents = useMemo(
    () => incidents.filter((incident) => incident.lifecycle_stage !== "Resolved"),
    [incidents]
  );

  return (
    <div className="kiosk-root">
      <div className="kiosk-panel">
        <header className="kiosk-header">
          <p className="kiosk-wordmark">RACKWATCH</p>
          <span className="kiosk-conn-dot" data-status={connectionStatus} aria-hidden="true" />
        </header>

        <Banner ok={openIncidents.length === 0} siteName={site.name} openIncidents={openIncidents} devices={devices} states={states} />

        {columns.size === 0 ? (
          <p className="kiosk-empty">{connectionStatus === "open" ? "No devices configured." : "Connecting…"}</p>
        ) : (
          <div className="kiosk-columns" style={{ gridTemplateColumns: `repeat(${columns.size}, 1fr)` }}>
            {Array.from(columns.entries()).map(([columnName, groups]) => (
              <Column key={columnName} name={columnName} groups={groups} states={states} />
            ))}
          </div>
        )}

        <Footer configLabel={site.config_label} pollIntervalMs={pollIntervalMs} lastPollAt={lastPollAt} nowMs={nowMs} />
      </div>
    </div>
  );
}
