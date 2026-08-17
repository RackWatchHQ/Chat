// ============================================================
// RackWatch Seed Configuration — Build 1
// ============================================================
//
// PLACEHOLDER DATA. Replace the addresses, UniFi credentials, and
// device/check ids below with your real inventory before running
// against production hardware. This file exists so the scheduler
// has something concrete to poll and so the dependency/incident
// pipeline has at least one real relationship to reason about.
//
// Layout mirrors the illustrative example in dependency-evaluator.ts:
// one core switch (upstream) and one access switch (downstream) that
// depends on it, plus a third standalone device with no dependency,
// to show both code paths.
//
// dashboard_column / dashboard_group (in metadata): purely presentation -
// which kiosk-dashboard column a device is listed under, and which
// subheading within that column. Device.metadata is DM-009's "controlled
// extensible attributes" - the right place for this, rather than adding
// UI-only fields to the core Device shape in domain-model.ts. A device
// with no dashboard_group renders directly under its column with no
// subheading (see switch-dashboard.jsx).
//
// MAC addresses: none of the devices below have a "mac" entry in
// addresses[] - fine for this placeholder data, but if
// unmonitored-device-job.ts (MVP stopgap) is enabled, ANY known
// Device without a recorded MAC is invisible to its UniFi-vs-known-
// Device diff and can get permanently misflagged as "unmonitored."
// Add a { type: "mac", value: "..." } entry per device before
// enabling that job - see its file header for why this is a
// documented requirement rather than something the job works around.
// ============================================================

import type { Device, Check, DependencyRecord, Integration } from "./domain-model";

// Identifies which site this deployment's dashboard is for - shown in
// the kiosk banner and footer. One kiosk instance = one site.
export const siteInfo = {
  name: "Rack 1",
  config_label: "rackwatch-v0.1",
};

// Which OS-level network interfaces (as os.networkInterfaces() names
// them, e.g. "eth1") are RackWatch Monitoring ports - discovery-adapter.ts
// sweeps exactly these, never every interface on the host. The OS has
// no concept of "this is a Monitoring port vs. Management/loopback,"
// so this mapping has to be explicit config, not inferred - the actual
// subnet/CIDR for each one IS read live via OS introspection (never
// duplicated here), only WHICH interfaces to introspect is config.
// PLACEHOLDER - replace with your real interface names before running
// discovery-adapter.ts against production hardware.
export const monitoringInterfaceNames = ["eth1", "eth2"];

export const integrations: Integration[] = [
  {
    integration_id: "unifi-main",
    type: "unifi",
    // REPLACE with your controller's base_url, api_key (Settings ->
    // Integrations), and site_id. See unifi-adapter.ts header comment
    // re: singular vs plural "integration(s)" in the path.
    config: {
      base_url: "https://192.168.1.1/proxy/network/integration/v1",
      api_key: "REPLACE_ME",
      site_id: "default",
    },
    health: { status: "Unavailable" },
  },
];

export const devices: Device[] = [
  {
    device_id: "core-switch-a",
    name: "Rack 1 - Core Switch",
    type: "Network Switch",
    operational_role: "Core Switch",
    operational_system: "Network",
    vendor: "Ubiquiti",
    model: "USW-Pro-24",
    monitoring_interface: "Monitoring A",
    addresses: [{ type: "ip", value: "192.168.1.10" }],
    dependencies: [],
    checks: ["check-core-switch-a-icmp"],
    adapter_refs: [{ integration_id: "unifi-main", external_id: "REPLACE_WITH_UNIFI_DEVICE_ID" }],
    metadata: { dashboard_column: "Infrastructure", dashboard_group: "Switches" },
    current_state: "Unknown",
  },
  {
    device_id: "access-switch-b",
    name: "Rack 2 - Access Switch",
    type: "Network Switch",
    operational_role: "Access Switch",
    operational_system: "Network",
    vendor: "Ubiquiti",
    model: "USW-24-PoE",
    monitoring_interface: "Monitoring A",
    addresses: [{ type: "ip", value: "192.168.1.11" }],
    dependencies: ["core-switch-a"],
    checks: ["check-access-switch-b-icmp"],
    adapter_refs: [],
    metadata: { dashboard_column: "Infrastructure", dashboard_group: "Switches" },
    current_state: "Unknown",
  },
  {
    device_id: "access-switch-c",
    name: "Rack 3 - Access Switch",
    type: "Network Switch",
    operational_role: "Access Switch",
    operational_system: "Network",
    vendor: "Ubiquiti",
    model: "USW-24-PoE",
    monitoring_interface: "Monitoring A",
    addresses: [{ type: "ip", value: "192.168.1.12" }],
    dependencies: [],
    checks: ["check-access-switch-c-icmp"],
    adapter_refs: [],
    metadata: { dashboard_column: "Infrastructure", dashboard_group: "Switches" },
    current_state: "Unknown",
  },
];

export const checks: Check[] = [
  {
    check_id: "check-core-switch-a-icmp",
    device_id: "core-switch-a",
    type: "icmp_ping",
    interval_seconds: 30,
    timeout_seconds: 2,
    enabled: true,
  },
  {
    check_id: "check-access-switch-b-icmp",
    device_id: "access-switch-b",
    type: "icmp_ping",
    interval_seconds: 30,
    timeout_seconds: 2,
    enabled: true,
  },
  {
    check_id: "check-access-switch-c-icmp",
    device_id: "access-switch-c",
    type: "icmp_ping",
    interval_seconds: 30,
    timeout_seconds: 2,
    enabled: true,
  },
];

export const dependencies: DependencyRecord[] = [
  {
    dependency_id: "dep-core-a-to-access-b",
    upstream_device_id: "core-switch-a",
    downstream_device_id: "access-switch-b",
    type: "network_uplink",
    authority: "Configured",
    confidence: "High",
    enabled: true,
  },
];
