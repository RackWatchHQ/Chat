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
// Also exports a second check, runSnmpInterfaceHealthCheck: per-
// interface error-rate/utilization counters (ifTable/ifXTable) for a
// device's opted-in Device.monitored_interfaces, feeding the Degraded
// state (state-engine.ts). Like the baseline check above, this file
// only reports RAW current counter values - it does not compute
// rates, does not compare against a prior reading, and does not
// decide what counts as "elevated." Counters are cumulative, so a
// single reading is meaningless without a prior one to diff against;
// that comparison (and the wraparound/reboot handling it requires)
// is the State Engine's job, same division of labour as everywhere
// else in this file.
//
// Deliberately NOT done in this file (future steps):
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
const OID_SYS_NAME = "1.3.6.1.2.1.1.5.0";
const BASELINE_OIDS = [OID_SYS_DESCR, OID_SYS_OBJECT_ID, OID_SYS_UP_TIME];
const IDENTITY_OIDS = [OID_SYS_DESCR, OID_SYS_OBJECT_ID, OID_SYS_NAME, OID_SYS_UP_TIME]; // discovery-adapter.ts Tier 3

// ---- Standard IF-MIB interface-table OIDs (RFC 2863) ----
// ifHCInOctets/ifHCOutOctets (64-bit) are used instead of the 32-bit
// ifInOctets/ifOutOctets - a 2.5G link can wrap a 32-bit octet counter
// within a normal poll interval, which would look identical to a
// device reboot to the wraparound check in state-engine.ts. ifInErrors/
// ifOutErrors stay 32-bit (Counter32) - RFC 2863 has no 64-bit error
// counter variants, and error counts don't grow fast enough to wrap
// within a poll interval the way octet counts do.

const IF_IN_ERRORS_BASE = "1.3.6.1.2.1.2.2.1.14";
const IF_OUT_ERRORS_BASE = "1.3.6.1.2.1.2.2.1.20";
const IF_HC_IN_OCTETS_BASE = "1.3.6.1.2.1.31.1.1.1.6";
const IF_HC_OUT_OCTETS_BASE = "1.3.6.1.2.1.31.1.1.1.10";
const IF_HIGH_SPEED_BASE = "1.3.6.1.2.1.31.1.1.1.15"; // Mbps - needed to turn an octet delta into a utilization %

// Order matters - decodeInterfaceReadings() below relies on this
// exact sequence to map a flat varbind array back to named fields.
const INTERFACE_OID_BASES = [
  IF_IN_ERRORS_BASE,
  IF_OUT_ERRORS_BASE,
  IF_HC_IN_OCTETS_BASE,
  IF_HC_OUT_OCTETS_BASE,
  IF_HIGH_SPEED_BASE,
] as const;

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
// provision on either the MVP Pi 5 or v0.9 CM5 Lite image). Shared by
// both checks in this file - session creation, the "error" listener,
// and cleanup are identical regardless of which OIDs get requested.
// Throws on anything beyond a normal timeout; each caller decides how
// to turn "timed out" vs. "something else went wrong" into its own
// result shape, same principle icmp-adapter.ts and unifi-adapter.ts
// apply for their own unavailability cases - a failed poll is data,
// not an exception, but what KIND of data is check-specific.

async function fetchVarbinds(config: SnmpSessionConfig, oids: string[]): Promise<snmp.Varbind[]> {
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
    return await Promise.race([getVarbinds(session, oids), socketError]);
  } finally {
    session.close();
  }
}

interface SnmpSessionConfig {
  address: string;
  community: string;
  version?: "1" | "2c";
  port?: number;
  timeout_seconds: number;
  retries: number;
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

async function querySystemGroup(config: SnmpCheckConfig): Promise<SnmpResult> {
  try {
    const varbinds = await fetchVarbinds(config, BASELINE_OIDS);

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
  }
}

// ---- Multi-community identity query (discovery-adapter.ts Tier 3) ----
// Different usage shape from querySystemGroup above: that one already
// knows a device's single configured community string (from an
// Integration). This one is trying to identify a host discovered by
// an ARP sweep that RackWatch has no prior SNMP config for at all -
// it tries each candidate community in order, first successful
// response wins. Never throws: a host that answers to none of them is
// exactly as valid an outcome as one that does (discovery-adapter.ts
// must still report it from Tier 1/2 alone), so every failure mode
// here - timeout, bad community, malformed response - just means "try
// the next string," and running out of strings means "no identity
// data this cycle," not an error to propagate.

export interface SnmpIdentityResult {
  sys_descr?: string;
  sys_object_id?: string;
  sys_name?: string;
  uptime_seconds?: number; // converted from TimeTicks (centiseconds) - NOT the same unit as
                             // SnmpResult.sys_up_time_ticks above, which stays in raw ticks
  community_used?: string;
}

export async function queryDeviceIdentity(
  address: string,
  communityStrings: string[],
  timeoutSeconds: number,
  retries: number,
  port?: number // defaults to 161 (via fetchVarbinds/createSession) - same optionality as SnmpCheckConfig.port
                 // above; exists for the rare non-standard-port site, and for testing without root
                 // (binding a real agent to 161 needs elevated privileges, a high port doesn't)
): Promise<SnmpIdentityResult | undefined> {
  for (const community of communityStrings) {
    try {
      const varbinds = await fetchVarbinds({ address, community, port, timeout_seconds: timeoutSeconds, retries }, IDENTITY_OIDS);
      const ticks = readTimeTicks(varbinds[3]);
      return {
        sys_descr: readOctetString(varbinds[0]),
        sys_object_id: readOid(varbinds[1]),
        sys_name: readOctetString(varbinds[2]),
        uptime_seconds: ticks !== undefined ? Math.round(ticks / 100) : undefined,
        community_used: community,
      };
    } catch {
      // Timeout, auth failure, malformed response - whatever the
      // reason, this community didn't work. Try the next one rather
      // than distinguishing why (unlike querySystemGroup, there's no
      // single-community "adapter trouble vs device trouble" call to
      // make here - trying the next string IS the handling).
      continue;
    }
  }
  return undefined; // exhausted every configured community - a normal outcome, not an error
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

// ============================================================
// Interface health check - per-interface counters for Degraded
// detection (state-engine.ts). See file header for the raw-values-
// only division of labour.
// ============================================================

// ---- Configuration for one interface-health check ----

export interface SnmpInterfaceCheckConfig {
  device_id: string;
  address: string;
  community: string;
  version?: "1" | "2c";
  port?: number;
  timeout_seconds: number;
  retries: number;
  interfaces: string[];   // ifIndex list - Device.monitored_interfaces. Caller's responsibility to
                            // skip this check entirely when empty/unset (opt-in only, see domain-model.ts)
}

// ---- The raw per-interface result shape this check produces ----
// Every field is optional and independently absent-able - a varbind
// error on ONE OID for ONE interface (e.g. a stale ifIndex) shouldn't
// invalidate the rest of the reading (DM-002: represented as genuinely
// absent, not guessed at). Octet counters are kept as decimal strings,
// not numbers - net-snmp decodes Counter64 as a JS bigint, and
// JSON.stringify cannot serialize a bigint directly, which matters
// here because Observation.result round-trips through JSON in both
// persistence.ts and ws-server.ts.

export interface InterfaceCounterReading {
  if_index: string;
  if_in_errors?: number;
  if_out_errors?: number;
  if_hc_in_octets?: string;
  if_hc_out_octets?: string;
  if_high_speed_mbps?: number;
}

export interface SnmpInterfaceHealthResult {
  readings: InterfaceCounterReading[]; // one entry per requested ifIndex that responded at all
  error?: string;                       // populated only on an unexpected failure (not a normal timeout)
}

// ---- The check's one job: read current counter values for the
// requested interfaces, and report what happened. No rate/delta
// computation, no wraparound handling - see file header. ----

export async function runSnmpInterfaceHealthCheck(config: SnmpInterfaceCheckConfig): Promise<Observation> {
  const { device_id } = config;
  const startedAt = Date.now();

  const result = await queryInterfaceCounters(config);

  return {
    observation_id: randomUUID(),
    timestamp: new Date().toISOString(),
    target: device_id,
    source: "snmp-adapter",
    type: "snmp_interface_health",
    result,
    quality: "corroborating", // same baseline tier as the reachability check
    freshness_seconds: Math.round((Date.now() - startedAt) / 1000),
    schema_version: SCHEMA_VERSION,
  };
}

async function queryInterfaceCounters(config: SnmpInterfaceCheckConfig): Promise<SnmpInterfaceHealthResult> {
  if (config.interfaces.length === 0) {
    // Nothing opted in - don't even hit the network. Callers are
    // expected to skip this check entirely in this case (domain-model.ts),
    // but this guard keeps the function itself safe to call regardless.
    return { readings: [] };
  }

  try {
    const varbinds = await fetchVarbinds(config, buildInterfaceOids(config.interfaces));
    return { readings: decodeInterfaceReadings(config.interfaces, varbinds) };
  } catch (err) {
    if (err instanceof Error && err.name === "RequestTimedOutError") {
      // No response within timeout x retries - a normal, expected
      // outcome, not an error condition (mirrors the reachability check).
      return { readings: [] };
    }
    return {
      readings: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Builds a flat OID list across every requested interface, in the
// fixed INTERFACE_OID_BASES order - decodeInterfaceReadings() below
// relies on that same order to map results back to named fields.
function buildInterfaceOids(interfaces: string[]): string[] {
  const oids: string[] = [];
  for (const ifIndex of interfaces) {
    for (const base of INTERFACE_OID_BASES) {
      oids.push(`${base}.${ifIndex}`);
    }
  }
  return oids;
}

function decodeInterfaceReadings(interfaces: string[], varbinds: snmp.Varbind[]): InterfaceCounterReading[] {
  const fieldsPerInterface = INTERFACE_OID_BASES.length;
  return interfaces.map((ifIndex, i) => {
    const offset = i * fieldsPerInterface;
    return {
      if_index: ifIndex,
      if_in_errors: readCounter32(varbinds[offset]),
      if_out_errors: readCounter32(varbinds[offset + 1]),
      if_hc_in_octets: readCounter64(varbinds[offset + 2]),
      if_hc_out_octets: readCounter64(varbinds[offset + 3]),
      if_high_speed_mbps: readCounter32(varbinds[offset + 4]), // ifHighSpeed is Gauge32 - same plain-number decode
    };
  });
}

function readCounter32(varbind: snmp.Varbind): number | undefined {
  if (snmp.isVarbindError(varbind) || varbind.value == null) return undefined;
  const value = Number(varbind.value);
  return Number.isFinite(value) ? value : undefined;
}

function readCounter64(varbind: snmp.Varbind): string | undefined {
  if (snmp.isVarbindError(varbind) || varbind.value == null) return undefined;
  // net-snmp decodes Counter64 as a bigint - kept as a decimal string
  // here rather than a number, both to avoid precision loss on a
  // high-throughput long-uptime link and because JSON.stringify cannot
  // serialize a bigint directly (see InterfaceCounterReading above).
  return typeof varbind.value === "bigint" ? varbind.value.toString() : String(varbind.value);
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
