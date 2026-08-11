// ============================================================
// RackWatch Domain Model — Build 1
// ============================================================
//
// HOW TO READ THIS FILE (for non-coders):
// Everything below is just a "shape" definition, not logic.
// It says "a Device has these fields, of these types" - it doesn't
// say what a Device does. Think of it like a form template: this
// file defines the blank forms; other code will later fill them in
// and act on them.
//
// Every comment tagged with a spec code (e.g. DM-001, SE-009) points
// back to the requirement in the Engineering Specification that this
// field or type exists to satisfy. If a future change conflicts with
// one of these tags, that's a signal to check the spec before proceeding.
//
// Nothing in this file implements the State Engine's reasoning,
// the Incident Engine's correlation logic, or the anti-flapping
// hysteresis rules (spec 5.5). Those are built on TOP of these
// shapes, in later steps.
// ============================================================


// ---- Shared vocabularies ----

// 5.4 — routine presentation uses these three tiers rather than a raw percentage
export type Confidence = "High" | "Moderate" | "Low";

// 5.2 — the five states a Device can be in, and only in
export type DeviceState =
  | "Healthy"
  | "Degraded"
  | "Critical"
  | "Unknown"
  | "Dependency";

// 5.3 — how the State Engine characterises a piece of Evidence
export type EvidencePolarity =
  | "Positive"
  | "Negative"
  | "Neutral"
  | "Contradictory"
  | "Unavailable"
  | "Stale";

// 8.8 — how strongly a Dependency relationship is trusted
export type DependencyAuthority = "Configured" | "Verified" | "Inferred";

// 7.2 — the fixed lifecycle stages an Incident moves through
export type IncidentLifecycleStage =
  | "Detected"
  | "Correlating"
  | "Active"
  | "Recovering"
  | "Resolved";


// ---- Device (spec 8.3) ----
// The principal object in Build 1. Represents one physical or logical
// thing RackWatch evaluates - e.g. one Ubiquiti switch.

export interface Device {
  device_id: string;          // DM-001: stable, independent of IP/hostname/vendor id - never changes
  name: string;                // operator-facing name, e.g. "Rack 2 - Access Switch"
  type: string;                 // what it is, e.g. "Network Switch"
  operational_role: string;     // why it matters, e.g. "Access Switch" (see 8.4)
  operational_system: string;   // user-facing grouping, e.g. "Network" (see 8.5)
  vendor?: string;
  model?: string;
  monitoring_interface: "Monitoring A" | "Monitoring B"; // which RackWatch NIC reaches it (3.3)
  addresses: DeviceAddress[];
  dependencies: string[];        // device_ids this device relies on upstream (8.8)
  checks: string[];              // check_ids configured to evaluate this device
  adapter_refs: AdapterReference[];
  metadata: Record<string, unknown>; // controlled extensible attributes (DM-009)
  current_state: DeviceState;    // set ONLY by the State Engine - never by an adapter or the UI (5.1)
}

export interface DeviceAddress {
  type: "ip" | "hostname" | "mac" | "other";
  value: string;
}

export interface AdapterReference {
  integration_id: string;  // which configured Integration this reference belongs to
  external_id: string;     // the vendor's own id for this device, e.g. UniFi's internal device id
}


// ---- Check (spec 8.7) ----
// A configured method of obtaining evidence about one Device.
// A Check produces Observations. A Check never assigns State.

export interface Check {
  check_id: string;
  device_id: string;
  type: string;                 // e.g. "icmp_ping", "unifi_port_status"
  integration_id?: string;      // which Integration/Adapter runs this check, if any
  interval_seconds: number;
  timeout_seconds: number;
  enabled: boolean;
}


// ---- Observation (spec 8.7) ----
// A timestamped technical fact returned by a Check or Adapter.
// Observations are raw and uninterpreted - they do not say
// whether a device is healthy. Only the State Engine interprets them.

export interface Observation {
  observation_id: string;
  timestamp: string;            // ISO-8601
  target: string;                // device_id (or interface id) this observation is about
  source: string;                 // integration_id / adapter that produced it
  type: string;                  // e.g. "icmp_reachability", "unifi_port_status"
  result: unknown;               // normalised result payload - shape depends on adapter type
  quality: "authoritative" | "corroborating" | "weak"; // rough trust tier of the source
  freshness_seconds: number;      // how old this observation was when last used
  raw_evidence_ref?: string;      // optional pointer to the original vendor payload, for diagnostics
  schema_version: string;         // DM-008: observation schema is versioned independently of everything else
}


// ---- Evidence (spec 5.3) ----
// The State Engine's interpretation of one or more Observations,
// in context. This is where "3 timeouts in a row" becomes
// meaningful rather than just three data points.

export interface Evidence {
  evidence_id: string;
  device_id: string;
  derived_from: string[];        // observation_ids that produced this evidence
  polarity: EvidencePolarity;
  description: string;            // human-readable, e.g. "Repeated ICMP timeouts"
  weight: "strong" | "moderate" | "weak";
  timestamp: string;
}


// ---- State (spec 5.1, 5.9) ----
// The authoritative, current conclusion for one Device.
// Nothing except the State Engine may write to this.

export interface DeviceStateRecord {
  device_id: string;
  state: DeviceState;
  confidence: Confidence;
  since: string;                  // ISO-8601 timestamp of the last transition into this state
  explanation?: StateExplanation; // required for every non-Healthy state (SE-009)
}

export interface StateExplanation {
  conclusion: string;              // e.g. "Device unreachable"
  principal_reason: string;        // e.g. "3 consecutive ICMP timeouts"
  supporting_evidence: string[];   // evidence_ids
  confidence: Confidence;
  duration_seconds: number;
  dependency_ref?: string;         // device_id of the upstream cause, only set when state = "Dependency"
}


// ---- Event (spec 8.2) ----
// A record that something meaningful changed. Build 1's primary
// use of this is recording state transitions for the activity feed
// and for the Incident Engine to consume later.

export interface StateTransitionEvent {
  event_id: string;
  device_id: string;
  timestamp: string;
  from_state: DeviceState;
  to_state: DeviceState;
  reason: string;
  evidence_ids: string[];
}


// ---- Dependency (spec 8.8) ----
// A directed relationship: "downstream_device_id relies on
// upstream_device_id." Used by the State Engine to explain a
// device as Dependency rather than Critical.

export interface DependencyRecord {
  dependency_id: string;
  upstream_device_id: string;
  downstream_device_id: string;
  type: string;                    // e.g. "network_uplink", "power"
  authority: DependencyAuthority;
  confidence: Confidence;
  enabled: boolean;
}


// ---- Integration / Adapter (spec 8.9) ----
// An Integration is a configured external source (e.g. "our UniFi
// controller"). An Adapter is the code that talks to it.

export interface Integration {
  integration_id: string;
  type: string;                     // e.g. "unifi", "icmp"
  config: Record<string, unknown>;  // integration-specific, validated by its adapter
  health: AdapterHealth;
}

export interface AdapterHealth {
  status: "Healthy" | "Degraded" | "Unavailable";
  last_successful_poll?: string;
  last_error?: string;
}


// ---- Adapter Plugin contract (v0.9 spec §4.4) ----
// Formalises the Integration / AdapterReference / Observation shapes
// above into "this is how a new vendor adapter gets built and loaded" -
// the explicit contract §4.4 calls for before handing adapter
// development to an external team. icmp-adapter.ts, unifi-adapter.ts
// and snmp-adapter.ts each export a plugin object conforming to this
// (see the `*AdapterPlugin` export at the bottom of those files) -
// together they exercise every combination this shape needs to
// support: no Integration at all (ICMP), an Integration but no
// AdapterReference (SNMP - it addresses the device directly), and
// both (UniFi - looked up via a controller by external_id).
//
// This is a TYPE contract only. It says nothing about how a plugin is
// packaged, downloaded, or code-signed (v0.9 spec §4.2/§4.3) - that is
// separate, hardware-trust-dependent infrastructure layered on top of
// this shape, not part of it.

export interface AdapterCheckContext {
  device_id: string;
  address?: string;                // set when the plugin addresses the device directly (ICMP, SNMP)
  integration?: Integration;        // set when requires_integration is true
  adapter_ref?: AdapterReference;   // set when requires_adapter_reference is true
  check: Check;
}

export interface AdapterPlugin {
  readonly adapter_type: string;        // matches Integration.type / the Check.type family, e.g. "snmp"
  readonly produces: readonly string[];  // Observation.type values this plugin can emit, e.g. ["snmp_reachability"]
  readonly requires_integration: boolean;       // false only for ICMP - no Integration is configured for it at all
  readonly requires_adapter_reference: boolean;  // true only for UniFi - needs external_id to find the device

  // Per spec 8.9 (unchanged by this contract): must never assign
  // Device State, open/close Incidents, or determine UI presentation -
  // only turn raw results into an Observation.
  runCheck(context: AdapterCheckContext): Promise<Observation>;

  // Adapter-level connectivity health, independent of any one device
  // poll (8.9). Optional - a baseline adapter with no controller of
  // its own (ICMP, SNMP) has nothing separate to report here.
  checkHealth?(integration: Integration): Promise<AdapterHealth>;
}


// ---- Incident (stub only) ----
// Placeholder shape so the API contract is stable once we build the
// Incident Engine. Deliberately minimal - do not add correlation
// logic here. This exists now only so other components have a
// stable shape to reference.

export interface IncidentStub {
  incident_id: string;
  lifecycle_stage: IncidentLifecycleStage;
  affected_device_ids: string[];
  most_probable_root_cause?: string; // device_id, if known
  created_at: string;
}


// ---- Site / Appliance (spec 8.2) ----
// Minimal stubs. Not needed for the switch-monitoring path in the
// near term, but included so the schema matches the full spec
// and nothing has to be retrofitted later.

export interface Site {
  site_id: string;
  name: string;
}

export interface Appliance {
  appliance_id: string;              // public RackWatch ID - HW-006: never treated as an auth secret
  site_id: string;                    // PO-002: one appliance monitors exactly one site in Build 1
  version: string;
  health: "Healthy" | "Degraded" | "Critical"; // logo LED state - kept separate from Device health (DP-011)
}
