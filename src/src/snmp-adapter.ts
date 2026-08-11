// ============================================================
// SNMP Adapter — Build 1 (RWS-002 §2.2 "Layered evidence model")
// ============================================================
//
// HOW TO READ THIS FILE (for non-coders):
// This is the second baseline Adapter, alongside icmp-adapter.ts.
// Per RWS-002 §2.2, SNMP and ICMP together form the permanent
// monitoring baseline for every supported device - a baseline that
// keeps running even when a richer vendor-specific adapter (like
// unifi-adapter.ts) is also available for that device. This file's
// job is narrow: query a device's standard SNMP "system group"
// (sysUpTime, sysDescr, sysObjectID) and turn the raw answer into
// an Observation. It does NOT decide whether the device is healthy
// - that's the State Engine's job, and it doesn't understand this
// observation type yet (see "Deliberately NOT done" below).
//
// Per spec 8.9 (the same rule icmp-adapter.ts and unifi-adapter.ts
// follow), this file does NOT:
//   - assign final Device State
//   - open or close Incidents
//   - determine UI presentation
//
// Deliberately NOT done in this file (future steps):
//   - Per-interface polling (ifTable/ifOperStatus) - that's richer,
//     vendor/topology-adapter territory, not the baseline check.
//   - SNMPv3 (user-based security). RWS-002 §2.5 only speaks of
//     community strings for the baseline layer, so this file supports
//     v1/v2c only - v3 is a separate concern if/when it's needed.
//   - Acting on sysDescr/sysObjectID to pick a vendor adapter. RWS-002
//     §2.4 assigns that decision to a separate future component; this
//     file only carries the raw fingerprint fields as Observation data.
// ============================================================

import * as snmp from "net-snmp";
import { randomUUID } from "crypto";
import type { Observation, AdapterPlugin, AdapterCheckContext } from "./domain-model";

const SCHEMA_VERSION = "1.0.0"; // DM-008: observation schema versioned independently

// ---- Standard MIB-II system group OIDs (RFC 1213) ----
// Fixed and not configurable per check - RWS-002 §2.2's point is that
// SNMP is a uniform *baseline*, not a per-vendor query set.

const OID_SYS_DESCR = "1.3.6.1.2.1.1.1.0";
const OID_SYS_OBJECT_ID = "1.3.6.1.2.1.1.2.0";
const OID_SYS_UP_TIME = "1.3.6.1.2.1.1.3.0";
const BASELINE_OIDS = [OID_SYS_DESCR, OID_SYS_OBJECT_ID, OID_SYS_UP_TIME];

// ---- Configuration for one SNMP check ----
// Mirrors IcmpCheckConfig in icmp-adapter.ts as closely as the
// protocol allows.

export interface SnmpCheckConfig {
  device_id: string;        // which Device this check is about (becomes Observation.target)
  address: string;           // IP address or hostname to query
  community: string;          // SNMP community string (RWS-002 §2.5: adapter-handled, security-sensitive)
  version?: "1" | "2c";        // defaults to "2c" - community-string baseline only, no v3 (see file header)
  port?: number;                // defaults to 161
  timeout_seconds: number;     // per-attempt timeout
  retries: number;              // attempts before reporting unreachable
}

// ---- Integration-level configuration ----
// The community string is credential-like (RWS-002 §2.5), so - same
// as UnifiIntegrationConfig in unifi-adapter.ts - it lives on a
// configured Integration rather than inline on every Check. The
// device's own address (like ICMP) still comes from Device.addresses,
// since SNMP, unlike the UniFi API, talks to the device directly
// rather than through a controller keyed by external_id.

export interface SnmpIntegrationConfig {
  community: string;
  version?: "1" | "2c";
  port?: number;
}

// ---- The adapter's one job: query the system group, and report
// what happened. ----

export async function runSnmpCheck(config: SnmpCheckConfig): Promise<Observation> {
  const { device_id } = config;
  const startedAt = Date.now();

  const result = await querySystemGroup(config);

  return {
    observation_id: randomUUID(),
    timestamp: new Date().toISOString(),
    target: device_id,
    source: "snmp-adapter",            // 8.9: an Adapter identifies itself as the source
    type: "snmp_reachability",          // parallel to icmp_reachability - a second, independent baseline reading
    result,
    quality: "corroborating",           // 5.3: SNMP baseline is useful but not authoritative alone, same tier as ICMP
    freshness_seconds: Math.round((Date.now() - startedAt) / 1000),
    schema_version: SCHEMA_VERSION,
  };
}

// ---- The raw result shape this adapter produces ----
// Plain and uninterpreted, same spirit as IcmpResult / UnifiDeviceResult.
// sys_descr / sys_object_id double as RWS-002 §2.2's fingerprinting
// fields - carried here as raw facts, not acted on by this file.

export interface SnmpResult {
  reachable: boolean;
  sys_descr?: string;           // RWS-002 §2.2 fingerprint field
  sys_object_id?: string;        // RWS-002 §2.2 fingerprint field
  sys_up_time_ticks?: number;    // hundredths of a second since last (re)start - a reachability/reboot signal
  error?: string;                 // populated only on an unexpected failure (not a normal timeout)
}

// ---- Low-level SNMP GET ----
// Uses the net-snmp package (pure JS, no OS binary dependency to
// provision on either the MVP Pi 5 or v0.9 CM5 Lite image). Never
// throws on a normal timeout - only on something unexpected (bad
// hostname, malformed response). A failed poll is data, not an
// exception: the same principle icmp-adapter.ts and unifi-adapter.ts
// apply for their own unavailability cases.

async function querySystemGroup(config: SnmpCheckConfig): Promise<SnmpResult> {
  const version = config.version === "1" ? snmp.Version1 : snmp.Version2c;

  const session = snmp.createSession(config.address, config.community, {
    version,
    port: config.port ?? 161,
    timeout: config.timeout_seconds * 1000,
    retries: config.retries,
  });

  // net-snmp sessions emit "error" on transport-level failures (e.g. a
  // socket that can't be opened). Without a listener, Node treats an
  // unhandled "error" event as a thrown exception and crashes the
  // process - this MUST be attached before the request is sent.
  const socketError = new Promise<never>((_resolve, reject) => {
    session.on("error", (err: Error) => reject(err));
  });

  try {
    const varbinds = await Promise.race([getVarbinds(session, BASELINE_OIDS), socketError]);

    return {
      reachable: true,
      sys_descr: readOctetString(varbinds[0]),
      sys_object_id: readOid(varbinds[1]),
      sys_up_time_ticks: readTimeTicks(varbinds[2]),
    };
  } catch (err) {
    if (err instanceof Error && err.name === "RequestTimedOutError") {
      // No response within timeout x retries - a normal, expected
      // outcome, not an error condition (mirrors icmp-adapter.ts).
      return { reachable: false };
    }
    // Something went wrong beyond a normal timeout (bad hostname,
    // malformed response, socket error). Adapter trouble, not
    // necessarily device trouble - spec 5.8, same distinction the
    // other two adapters draw for their own unexpected errors.
    return {
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    session.close();
  }
}

function getVarbinds(session: snmp.Session, oids: string[]): Promise<snmp.Varbind[]> {
  return new Promise((resolve, reject) => {
    session.get(oids, (error, varbinds) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(varbinds ?? []);
    });
  });
}

// ---- Varbind decoding ----
// A varbind carrying NoSuchObject/NoSuchInstance/EndOfMibView means
// the agent responded but doesn't expose that particular OID - that's
// a per-field gap, not a reason to mark the whole device unreachable
// (DM-002: represented as genuinely absent, not guessed at).

function readOctetString(varbind: snmp.Varbind): string | undefined {
  if (snmp.isVarbindError(varbind) || varbind.value == null) return undefined;
  return Buffer.isBuffer(varbind.value) ? varbind.value.toString("utf8").trim() : String(varbind.value);
}

function readOid(varbind: snmp.Varbind): string | undefined {
  if (snmp.isVarbindError(varbind) || varbind.value == null) return undefined;
  return String(varbind.value);
}

function readTimeTicks(varbind: snmp.Varbind): number | undefined {
  if (snmp.isVarbindError(varbind) || varbind.value == null) return undefined;
  const value = Number(varbind.value);
  return Number.isFinite(value) ? value : undefined;
}

// ---- Formal plugin conformance (v0.9 spec §4.4) ----
// Wraps runSnmpCheck above to satisfy the AdapterPlugin contract
// (domain-model.ts), with no change to its behaviour. SNMP sits
// between the other two reference adapters: like UniFi it needs a
// configured Integration (the community string), but like ICMP it
// addresses the device directly and needs no AdapterReference.

const PLUGIN_DEFAULT_RETRIES = 1; // mirrors scheduler.ts's own DEFAULT_SNMP_RETRIES; duplicated rather than
                                    // imported so this plugin is self-contained for a loader that doesn't go
                                    // through scheduler.ts

export const snmpAdapterPlugin: AdapterPlugin = {
  adapter_type: "snmp",
  produces: ["snmp_reachability"],
  requires_integration: true,
  requires_adapter_reference: false,

  async runCheck(context: AdapterCheckContext): Promise<Observation> {
    if (!context.address) {
      throw new Error(`snmp adapter plugin requires an address for device ${context.device_id}`);
    }
    if (!context.integration) {
      throw new Error(`snmp adapter plugin requires a configured Integration for device ${context.device_id}`);
    }
    const snmpConfig = context.integration.config as unknown as SnmpIntegrationConfig;
    return runSnmpCheck({
      device_id: context.device_id,
      address: context.address,
      community: snmpConfig.community,
      version: snmpConfig.version,
      port: snmpConfig.port,
      timeout_seconds: context.check.timeout_seconds,
      retries: PLUGIN_DEFAULT_RETRIES,
    });
  },
};
