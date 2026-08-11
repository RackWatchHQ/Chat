// ============================================================
// UniFi Adapter — Build 1 (spec 8.10)
// ============================================================
//
// HOW TO READ THIS FILE (for non-coders):
// This is the second Adapter, alongside icmp-adapter.ts. Its job is
// the same shape: ask a source a question, turn the raw answer into
// an Observation. The difference is what it asks - instead of "did
// you respond to a ping," it asks UniFi's own controller "what do
// you think this switch's state is right now." That's a second,
// independent opinion the State Engine can eventually weigh against
// ICMP (spec 5.4: independent agreement is what unlocks High
// confidence - something ICMP alone could never reach).
//
// IMPORTANT - verify before relying on this in production:
// Ubiquiti's official Network Integration API is documented
// per-installation, INSIDE your own controller (Settings ->
// Integrations), and the exact path/response shape has been known
// to vary slightly between Network Application versions. Two things
// in particular to double-check against your own Cloud Key (running
// 10.5.67):
//   1. The base path below assumes /proxy/network/integration/v1
//      (singular "integration"). Some installations reportedly use
//      /proxy/network/integrations/v1 (plural). Check your own
//      controller's generated docs and correct base_url if needed -
//      it's a single config value, not scattered through the file.
//   2. The device status field is assumed to be `state`, with values
//      "ONLINE" / "OFFLINE". This is well attested across several
//      real integrations but not something this file blindly trusts -
//      see normaliseState() below, which treats anything it doesn't
//      explicitly recognise as "unknown" rather than guessing (DM-002).
//
// Per spec 8.9, this file (like the ICMP adapter) does NOT:
//   - assign final Device State
//   - open or close Incidents
//   - determine UI presentation
//
// Deliberately NOT done in this file (future steps):
//   - Port-level correlation (8.10's "correlate configured devices
//     with switch-port information") - device-level state only for now.
// ============================================================

import { randomUUID } from "crypto";
import type { Observation, AdapterHealth, Integration, AdapterPlugin, AdapterCheckContext } from "./domain-model";

const SCHEMA_VERSION = "1.0.0"; // DM-008: versioned independently of the ICMP adapter's schema

// ---- Configuration ----
// Per spec 8.10: the adapter must "use and remain restricted to the
// configured Host ID and Site ID" - there is deliberately no code path
// here that discovers or reaches beyond this one configured site.

export interface UnifiIntegrationConfig {
  base_url: string; // e.g. "https://192.168.1.1/proxy/network/integration/v1" - VERIFY against your own Cloud Key
  api_key: string;   // generated on the controller itself: Settings -> Integrations
  site_id: string;   // this appliance is restricted to exactly one site (PO-002)
}

// ---- The raw result shape this adapter produces ----
// Mirrors icmp-adapter.ts's IcmpResult in spirit: plain, uninterpreted
// facts. raw_device is kept in full so nothing is lost even if this
// file doesn't yet know how to parse every field UniFi returns
// (8.10: "tolerate non-breaking unknown fields").

export interface UnifiDeviceResult {
  vendor_state: "online" | "offline" | "unknown"; // normalised - see normaliseState()
  raw_state?: string;    // the exact string UniFi returned, kept for diagnostics
  raw_device?: unknown;  // the full raw device payload, uninterpreted
  error?: string;        // populated only on an unexpected failure (auth, network, bad response)
}

// ---- The adapter's main job: ask UniFi about one device, and
// report what it said. ----

export async function runUnifiDeviceCheck(
  config: UnifiIntegrationConfig,
  device_id: string,        // RackWatch's own device_id -> becomes Observation.target
  external_device_id: string // UniFi's id/mac for this device (from Device.adapter_refs)
): Promise<Observation> {
  const startedAt = Date.now();
  const result = await fetchDeviceState(config, external_device_id);

  return {
    observation_id: randomUUID(),
    timestamp: new Date().toISOString(),
    target: device_id,
    source: "unifi-adapter",         // 8.9: an Adapter identifies itself as the source
    type: "unifi_device_status",       // distinct from icmp_reachability - the State Engine
                                         // doesn't understand this type yet (see file header)
    result,
    quality: result.error ? "weak" : "authoritative", // 5.3: vendor-reported state, when it
                                                          // actually arrives, outranks ICMP alone
    freshness_seconds: Math.round((Date.now() - startedAt) / 1000),
    schema_version: SCHEMA_VERSION,
  };
}

// ---- Low-level API call ----

async function fetchDeviceState(
  config: UnifiIntegrationConfig,
  externalDeviceId: string
): Promise<UnifiDeviceResult> {
  const url = `${config.base_url}/sites/${config.site_id}/devices/${externalDeviceId}`;

  try {
    const response = await fetch(url, {
      headers: {
        "X-API-Key": config.api_key,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      // A non-2xx response - almost always auth trouble or a bad path.
      // This is adapter/API trouble, not device trouble (5.8) - the same
      // distinction the ICMP adapter draws for its own unexpected errors.
      return {
        vendor_state: "unknown",
        error: `UniFi API returned HTTP ${response.status} for ${url}`,
      };
    }

    const body = await response.json();
    // Some controller versions wrap results in { meta, data }, others
    // may not. Tolerate both rather than assuming one shape (8.10).
    const device = (body as { data?: unknown })?.data ?? body;

    return {
      vendor_state: normaliseState((device as { state?: unknown })?.state),
      raw_state:
        typeof (device as { state?: unknown })?.state === "string"
          ? ((device as { state: string }).state)
          : undefined,
      raw_device: device,
    };
  } catch (err) {
    // Network failure, DNS failure, controller unreachable, malformed
    // JSON, etc. Same principle as icmp-adapter.ts: a failed call is
    // data about the adapter, not a verdict about the device.
    return {
      vendor_state: "unknown",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Converts whatever UniFi's API actually returned into RackWatch's own
// small vocabulary. Anything not explicitly recognised becomes
// "unknown" rather than an assumption - DM-002: unknown properties are
// represented explicitly, never guessed at.

function normaliseState(rawState: unknown): "online" | "offline" | "unknown" {
  if (typeof rawState !== "string") return "unknown";
  const value = rawState.toUpperCase();
  if (value === "ONLINE") return "online";
  if (value === "OFFLINE" || value === "DISCONNECTED") return "offline";
  return "unknown";
}

// ---- Adapter health check ----
// Separate from device polling on purpose (8.9: "Report adapter health
// and freshness" as its own concern). Hits the lightweight /info
// endpoint rather than pulling full device data just to check the
// controller is reachable and authenticating correctly.

export async function fetchAdapterHealth(config: UnifiIntegrationConfig): Promise<AdapterHealth> {
  const url = `${config.base_url}/info`;

  try {
    const response = await fetch(url, {
      headers: { "X-API-Key": config.api_key, Accept: "application/json" },
    });

    if (!response.ok) {
      return {
        status: "Unavailable",
        last_error: `UniFi API returned HTTP ${response.status} on /info`,
      };
    }

    await response.json(); // just confirms the controller responded with valid JSON
    return {
      status: "Healthy",
      last_successful_poll: new Date().toISOString(),
    };
  } catch (err) {
    return {
      status: "Unavailable",
      last_error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---- Formal plugin conformance (v0.9 spec §4.4) ----
// Wraps runUnifiDeviceCheck and fetchAdapterHealth above to satisfy
// the AdapterPlugin contract (domain-model.ts), with no change to
// their behaviour. UniFi is the only one of the three reference
// adapters that needs both a configured Integration (controller
// credentials) and an AdapterReference (the controller's own id for
// this device) - unlike ICMP/SNMP, it never talks to the device
// directly.

export const unifiAdapterPlugin: AdapterPlugin = {
  adapter_type: "unifi",
  produces: ["unifi_device_status"],
  requires_integration: true,
  requires_adapter_reference: true,

  async runCheck(context: AdapterCheckContext): Promise<Observation> {
    if (!context.integration) {
      throw new Error(`unifi adapter plugin requires a configured Integration for device ${context.device_id}`);
    }
    if (!context.adapter_ref) {
      throw new Error(`unifi adapter plugin requires an AdapterReference for device ${context.device_id}`);
    }
    return runUnifiDeviceCheck(
      context.integration.config as unknown as UnifiIntegrationConfig,
      context.device_id,
      context.adapter_ref.external_id
    );
  },

  async checkHealth(integration: Integration): Promise<AdapterHealth> {
    return fetchAdapterHealth(integration.config as unknown as UnifiIntegrationConfig);
  },
};
