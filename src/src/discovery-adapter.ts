// ============================================================
// Discovery Adapter — Tier 1 + 2 + 3 (Prototype Phase)
// ============================================================
//
// HOW TO READ THIS FILE (for non-coders):
// Every other adapter (icmp/unifi/snmp-adapter.ts) answers a question
// about ONE ALREADY-KNOWN device: "is this specific IP reachable?"
// This one is different - it goes and finds devices RackWatch doesn't
// know about yet, by sweeping every configured Monitoring interface's
// subnet and reading back what responds. It reports IP + MAC address
// (Tier 1), a manufacturer guess from the MAC's OUI prefix (Tier 2),
// and - where a host answers SNMP - its self-reported identity
// (sysDescr/sysObjectID/sysName/uptime, Tier 3) for each host found -
// enough for a human to recognise "that's the core switch, a Netgear
// M4250, up 14 days," not just "that's a MAC address."
//
// Per spec 8.9 (the same rule every other adapter follows), this file
// does NOT:
//   - assign final Device State
//   - open or close Incidents
//   - determine UI presentation
//   - add anything to the monitored Device list on its own - a human
//     (or later, a config UI) turns a DiscoveredHost into a Device
//
// Deliberately NOT done in this file (future steps, see
// docs/discovery-adapter-scope.md §2):
//   - Interface table walk (ifTable/ifXTable) - bigger, fiddlier SNMP
//     work; fast-follow once the sweep + dashboard are proven.
//   - Active TCP port scanning - more intrusive than a ping+ARP
//     sweep, not something to run automatically on a live network.
//   - Full vendor adapter matching (auto-detecting that a fingerprint
//     matches an installed adapter) - separate, later work.
//   - SNMPv3 for Tier 3 - community-string only (v1/v2c), same
//     scope boundary snmp-adapter.ts's baseline check already draws.
// ============================================================

import { exec } from "child_process";
import { promisify } from "util";
import { readFile } from "fs/promises";
import os from "os";
import ouiDataRaw from "./oui-data.json";
import { queryDeviceIdentity, type SnmpIdentityResult } from "./snmp-adapter";

const execAsync = promisify(exec);

// ---- The output shape (docs/discovery-adapter-scope.md §3) ----
// A DISCOVERED host is not yet a monitored Device. It has no
// device_id, no Checks, no dependencies - it's a candidate, not a
// conclusion. Nothing here is a State Engine input; discovery never
// touches current_state. mac/snmp are genuinely optional (DM-002:
// represent absence, don't guess) - mac is absent if the ARP entry
// expired before this file could read it; snmp is entirely unset
// until Tier 3 exists.

export interface DiscoveredHost {
  ip: string;
  mac?: string;
  vendor_guess?: string;
  snmp?: {
    sys_descr?: string;
    sys_object_id?: string;
    sys_name?: string;
    uptime_seconds?: number;
    community_used?: string;
  };
  first_seen: string; // ISO-8601
  last_seen: string;
}

// The results-view/persistence projection of a DiscoveredHost - NOT
// part of the scope doc's confirmed shape above, which stays exactly
// as specified. added_at is UI/persistence bookkeeping only
// ("has a human already actioned this row") - this file's own sweep
// logic (runDiscoverySweep, mergeDiscoveredHosts) never sets or reads
// it, only produces plain DiscoveredHost. Same "slim projection, not
// a domain-model change" pattern ws-server.ts's DeviceSummary already
// uses for Device.

export interface DiscoveredHostRecord extends DiscoveredHost {
  added_at?: string; // set once, when a human clicks "add as monitored device" in the results view
}

export function hostKey(host: { ip: string; mac?: string }): string {
  return host.mac ?? host.ip;
}

// ============================================================
// Step 1: which subnets to sweep (OS introspection, not config) -
// config only says WHICH OS interfaces are Monitoring ports
// (config.ts's monitoringInterfaceNames); the actual IP/netmask for
// each one is read live so it can never drift out of sync with the
// appliance's real network config.
// ============================================================

export interface SubnetInfo {
  interfaceName: string;
  cidr: string; // e.g. "192.168.1.0/24"
}

export function getMonitoringSubnets(
  interfaceNames: string[],
  networkInterfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()
): SubnetInfo[] {
  const subnets: SubnetInfo[] = [];

  for (const name of interfaceNames) {
    const addresses = networkInterfaces[name];
    if (!addresses) {
      console.warn(`[discovery-adapter] configured Monitoring interface "${name}" not found on this host`);
      continue;
    }
    const ipv4 = addresses.find((a) => a.family === "IPv4" && !a.internal);
    if (!ipv4) {
      console.warn(`[discovery-adapter] Monitoring interface "${name}" has no active IPv4 address - skipped this sweep`);
      continue;
    }
    subnets.push({ interfaceName: name, cidr: `${networkAddress(ipv4.address, ipv4.netmask)}/${netmaskToPrefixLength(ipv4.netmask)}` });
  }

  return subnets;
}

function netmaskToPrefixLength(netmask: string): number {
  return netmask.split(".").reduce((bits, octet) => bits + Number(octet).toString(2).split("1").length - 1, 0);
}

function networkAddress(ip: string, netmask: string): string {
  const ipParts = ip.split(".").map(Number);
  const maskParts = netmask.split(".").map(Number);
  return ipParts.map((p, i) => p & maskParts[i]).join(".");
}

// ============================================================
// Step 2: CIDR -> host IP list. Hand-rolled (no netmask package -
// this is simple enough not to warrant a dependency, same reasoning
// as choosing net-snmp/node:sqlite over heavier alternatives
// elsewhere in this codebase).
// ============================================================

const MAX_SWEEP_HOSTS = 4096; // safety cap (a /20) - refuses to silently ping-flood a misconfigured huge subnet

export function cidrToHostIps(cidr: string): string[] {
  const [ip, prefixStr] = cidr.split("/");
  const prefix = Number(prefixStr);
  if (!ip || Number.isNaN(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`discovery-adapter: invalid CIDR "${cidr}"`);
  }

  const ipInt = ipToInt(ip);
  const maskInt = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const networkInt = (ipInt & maskInt) >>> 0;
  const broadcastInt = (networkInt | (~maskInt >>> 0)) >>> 0;

  let firstHost: number;
  let lastHost: number;
  if (prefix >= 31) {
    // /31 (RFC 3021 point-to-point) and /32 (single host) - no
    // network/broadcast address to exclude, every address is usable.
    firstHost = networkInt;
    lastHost = broadcastInt;
  } else {
    firstHost = networkInt + 1;
    lastHost = broadcastInt - 1;
  }

  const count = lastHost - firstHost + 1;
  if (count > MAX_SWEEP_HOSTS) {
    console.warn(
      `[discovery-adapter] ${cidr} has ${count} host addresses - refusing to sweep more than ${MAX_SWEEP_HOSTS} ` +
        "(safety cap against a misconfigured huge subnet). Narrow the interface's netmask if this is unexpected."
    );
    return [];
  }

  const ips: string[] = [];
  for (let i = firstHost; i <= lastHost; i++) ips.push(intToIp(i));
  return ips;
}

function ipToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => ((acc << 8) | Number(octet)) >>> 0, 0);
}

function intToIp(int: number): string {
  return [24, 16, 8, 0].map((shift) => (int >>> shift) & 0xff).join(".");
}

function ipInCidr(ip: string, cidr: string): boolean {
  const [rangeIp, prefixStr] = cidr.split("/");
  const prefix = Number(prefixStr);
  const maskInt = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipToInt(ip) & maskInt) >>> 0 === (ipToInt(rangeIp) & maskInt) >>> 0;
}

// ============================================================
// Step 3: ping sweep, to populate the OS's ARP cache. Doesn't care
// about individual ping results - unlike icmp-adapter.ts, "did THIS
// ping succeed" isn't the point; a host that never answers a ping but
// still shows up in the ARP table (having answered some other
// broadcast/ARP traffic) is just as valid a discovery. Platform-aware
// timeout flag: -W means milliseconds on macOS/BSD, seconds on Linux
// (the actual deployment target) - icmp-adapter.ts doesn't need to
// care about this distinction since it's never run in dev on this
// machine the way this sweep needs to be for testing.
// ============================================================

export async function pingSweep(ips: string[], timeoutSeconds = 1): Promise<void> {
  await Promise.all(ips.map((ip) => singlePing(ip, timeoutSeconds).catch(() => {})));
}

function singlePing(ip: string, timeoutSeconds: number): Promise<unknown> {
  const command =
    process.platform === "darwin"
      ? `ping -c 1 -W ${timeoutSeconds * 1000} ${ip}`
      : `ping -c 1 -W ${timeoutSeconds} ${ip}`;
  return execAsync(command, { timeout: (timeoutSeconds + 1) * 1000 });
}

// ============================================================
// Step 4: read the ARP table. Linux target reads /proc/net/arp
// directly; falls back to shelling out to `arp -a` (same shell-out
// pattern icmp-adapter.ts already uses for ping) when that's not
// available - which is also what makes this testable in dev on macOS.
// Parsing is a separate, pure function so both formats can be unit
// tested with fabricated text, no real ARP table required.
// ============================================================

export interface ArpEntry {
  ip: string;
  mac: string;
}

export async function readArpTable(): Promise<ArpEntry[]> {
  try {
    const raw = await readFile("/proc/net/arp", "utf8");
    return parseArpOutput(raw, "proc");
  } catch {
    const { stdout } = await execAsync("arp -a");
    return parseArpOutput(stdout, "command");
  }
}

const MAC_PATTERN = /\b([0-9a-fA-F]{1,2}(:[0-9a-fA-F]{1,2}){5})\b/;
const ZERO_MAC = "00:00:00:00:00:00";

export function parseArpOutput(raw: string, format: "proc" | "command"): ArpEntry[] {
  const entries: ArpEntry[] = [];

  if (format === "proc") {
    // "IP address  HW type  Flags  HW address  Mask  Device" - skip the header line.
    const lines = raw.trim().split("\n").slice(1);
    for (const line of lines) {
      const columns = line.trim().split(/\s+/);
      if (columns.length < 4) continue;
      const [ip, , flags, mac] = columns;
      if (flags === "0x0" || normaliseMac(mac) === ZERO_MAC) continue; // incomplete entry, not yet resolved
      entries.push({ ip, mac: normaliseMac(mac) });
    }
    return entries;
  }

  // "command" format (`arp -a`, macOS/BSD or Linux) - e.g.
  // "? (192.168.1.10) at aa:bb:cc:dd:ee:1 on en0 ifscope [ethernet]"
  for (const line of raw.split("\n")) {
    if (line.toLowerCase().includes("incomplete")) continue;
    const ipMatch = line.match(/\(([\d.]+)\)/);
    const macMatch = line.match(MAC_PATTERN);
    if (!ipMatch || !macMatch) continue;
    entries.push({ ip: ipMatch[1], mac: normaliseMac(macMatch[1]) });
  }
  return entries;
}

// Zero-pads each octet and lower-cases - `arp -a` output on macOS
// drops leading zeros (e.g. "aa:bb:cc:dd:ee:1"), /proc/net/arp and
// oui-data.json both expect the full, consistent form.
function normaliseMac(mac: string): string {
  return mac
    .split(":")
    .map((octet) => octet.toLowerCase().padStart(2, "0"))
    .join(":");
}

// ============================================================
// Tier 1 orchestration: sweep every configured Monitoring subnet,
// return only the ARP entries that actually fall within a subnet this
// run swept - the OS's ARP table is machine-wide and can carry
// stale/unrelated entries from other interfaces or previous state.
// ============================================================

export async function sweepTier1(subnets: SubnetInfo[], timeoutSeconds = 1): Promise<ArpEntry[]> {
  const allHostIps = subnets.flatMap((s) => cidrToHostIps(s.cidr));
  await pingSweep(allHostIps, timeoutSeconds);

  const arpTable = await readArpTable();
  return arpTable.filter((entry) => subnets.some((s) => ipInCidr(entry.ip, s.cidr)));
}

// ============================================================
// Tier 2: MAC -> vendor name via OUI prefix lookup. See oui-data.json
// for why its contents are placeholder, not real IEEE data.
// ============================================================

export type OuiTable = Record<string, string>; // 6-hex-char uppercase prefix -> vendor name

// Static import, not fs.readFile - tsc copies a statically-imported
// JSON file into dist/ alongside the compiled .js automatically;
// reading it dynamically via a __dirname-relative path does NOT get
// copied by `npm run build`, which broke `npm start` (only `npm run
// dev`, via tsx reading straight from src/, happened to still work).
// To use the real IEEE OUI registry instead of the placeholder data,
// replace oui-data.json's contents in place - see that file's header.
const { _comment, ...ouiTable } = ouiDataRaw as OuiTable & { _comment?: string };

export function loadOuiTable(): OuiTable {
  return ouiTable;
}

export function lookupVendor(mac: string, table: OuiTable): string | undefined {
  const prefix = mac.replace(/[:-]/g, "").toUpperCase().slice(0, 6);
  return table[prefix];
}

// ============================================================
// Merge into DiscoveredHost[], tracking first_seen/last_seen across
// runs. Pure - no I/O - so it's testable with fabricated previous-
// state, same pattern as computeReconciliation in
// unmonitored-device-job.ts. Keyed by MAC when available (the more
// stable identity - matches the whole unmonitored-device design's
// philosophy), falling back to IP only for entries with no MAC.
// ============================================================

export interface RawSweepResult {
  ip: string;
  mac?: string;
  vendor_guess?: string;
  snmp?: SnmpIdentityResult;
}

// Hosts NOT in this cycle's `current` results are CARRIED FORWARD
// unchanged (same first_seen, same last_seen - not bumped to now),
// not dropped. This matters for the persisted results view (§4 of the
// scope doc): a device that misses one 30-minute sweep (asleep,
// briefly disconnected) should read as "last seen 30 minutes ago" in
// the list, not silently vanish. This is a deliberate change from an
// earlier version of this function, which dropped absent hosts - that
// was closer to unmonitored-device-job.ts's "sustained presence"
// philosophy (a gap should reset it), which is the wrong model here:
// this function tracks a historical list, not a presence gate.
export function mergeDiscoveredHosts(previous: DiscoveredHost[], current: RawSweepResult[], now: string): DiscoveredHost[] {
  const previousByKey = new Map(previous.map((h) => [hostKey(h), h]));
  const seenThisCycle = new Set<string>();

  const updated = current.map((raw) => {
    const key = hostKey(raw);
    seenThisCycle.add(key);
    const existing = previousByKey.get(key);
    return {
      ip: raw.ip,
      mac: raw.mac,
      vendor_guess: raw.vendor_guess ?? existing?.vendor_guess,
      // Same "new data wins, else keep what we already knew" pattern
      // as vendor_guess - a host that answered SNMP once but times
      // out on a LATER sweep (Tier 3 never blocks/drops on failure)
      // shouldn't lose previously-learned identity data.
      snmp: raw.snmp ?? existing?.snmp,
      first_seen: existing?.first_seen ?? now,
      last_seen: now,
    };
  });

  const carriedForward = previous.filter((h) => !seenThisCycle.has(hostKey(h)));
  return [...updated, ...carriedForward];
}

// ============================================================
// Top-level: Tier 1 + 2 + 3. Not wired to any scheduler yet -
// directly invokable, same as every other not-yet-scheduled piece in
// this codebase.
// ============================================================

export interface DiscoverySnmpConfig {
  additional_communities?: string[]; // "public" is always tried first, automatically - see runIdentityQueries
  timeout_seconds?: number;           // kept short by default - discovery is best-effort sweeping across
                                        // many hosts, not a per-device monitoring check that can afford to wait
  retries?: number;
}

export interface DiscoverySweepConfig {
  monitoringInterfaceNames: string[];
  ping_timeout_seconds?: number;
  snmp?: DiscoverySnmpConfig;
}

const DEFAULT_SNMP_TIMEOUT_SECONDS = 1;
const DEFAULT_SNMP_RETRIES = 0; // no retries by default - one attempt per community is enough for a sweep;
                                  // per-device monitoring (snmp-adapter.ts's other check) is where retries matter

export async function runDiscoverySweep(
  config: DiscoverySweepConfig,
  previousHosts: DiscoveredHost[],
  now: string = new Date().toISOString()
): Promise<DiscoveredHost[]> {
  const subnets = getMonitoringSubnets(config.monitoringInterfaceNames);
  if (subnets.length === 0) {
    console.warn("[discovery-adapter] no active Monitoring subnets found - nothing to sweep this cycle");
    return mergeDiscoveredHosts(previousHosts, [], now);
  }

  const arpEntries = await sweepTier1(subnets, config.ping_timeout_seconds);
  const ouiTable = loadOuiTable();

  const tier1and2: RawSweepResult[] = arpEntries.map((entry) => ({
    ip: entry.ip,
    mac: entry.mac,
    vendor_guess: lookupVendor(entry.mac, ouiTable),
  }));

  const raw = await runIdentityQueries(tier1and2, config.snmp);

  return mergeDiscoveredHosts(previousHosts, raw, now);
}

// ---- Tier 3: layer SNMP identity onto this cycle's Tier 1+2 results.
// Concurrent across hosts (Promise.all, same reasoning as the Tier 1
// ping sweep) - sequentially querying 20-30 hosts one at a time would
// make the sweep unreasonably slow. Only queries hosts THIS cycle's
// ARP sweep actually found, never carried-forward/stale ones - see
// mergeDiscoveredHosts. Each per-host query already never throws
// (queryDeviceIdentity), so a non-responding host simply keeps
// whatever Tier 1+2 already found for it - Tier 3 can only ADD data
// here, never remove or block a host from the results. ----

async function runIdentityQueries(
  hosts: RawSweepResult[],
  snmpConfig: DiscoverySnmpConfig | undefined
): Promise<RawSweepResult[]> {
  const communities = ["public", ...(snmpConfig?.additional_communities ?? [])];
  const timeoutSeconds = snmpConfig?.timeout_seconds ?? DEFAULT_SNMP_TIMEOUT_SECONDS;
  const retries = snmpConfig?.retries ?? DEFAULT_SNMP_RETRIES;

  return Promise.all(
    hosts.map(async (host) => ({
      ...host,
      snmp: await queryDeviceIdentity(host.ip, communities, timeoutSeconds, retries),
    }))
  );
}

// ============================================================
// "Add as monitored device" - deliberately minimal per the scope
// doc's §4 ("plain list... with a manual add action") and the
// confirmed scope for this pass: config.ts's devices[] is a static
// TS export, read once at process start - there is no runtime-
// mutable Device store anywhere in this codebase to actually insert
// into. Rather than overclaim "this device is now live," this
// produces a ready-to-paste Device object literal for a human to
// copy into config.ts and restart. See ws-server.ts's add_device
// command handler (wired in server.ts) for where this gets called.
//
// monitoring_interface is left as an explicit TODO, not guessed -
// DiscoveredHost (the confirmed shape, unchanged) has no field
// recording which Monitoring interface a host was found on, and
// Device.monitoring_interface only accepts "Monitoring A" | "Monitoring B"
// today regardless (a real conflict already flagged during the
// original gap analysis - sweeping up to 4 interfaces but the type
// only names 2). Not resolved here; still a human's call either way.
// ============================================================

export function buildDeviceConfigSnippet(host: DiscoveredHostRecord): string {
  const lines = [
    "{",
    `  device_id: "TODO-choose-a-device-id",`,
    `  name: "${host.vendor_guess ?? "Unknown device"} (${host.ip})", // TODO: give this a real name`,
    `  type: "TODO", // e.g. "Network Switch"`,
    `  operational_role: "TODO",`,
    `  operational_system: "TODO",`,
    host.vendor_guess ? `  vendor: "${host.vendor_guess}",` : undefined,
    `  monitoring_interface: "Monitoring A", // TODO: confirm - see this function's header comment`,
    `  addresses: [`,
    `    { type: "ip", value: "${host.ip}" },`,
    host.mac ? `    { type: "mac", value: "${host.mac}" },` : `    // no MAC recorded - see unmonitored-device-job.ts's header for why this matters`,
    `  ],`,
    `  dependencies: [],`,
    `  checks: [], // TODO: add a check_id once one exists for this device`,
    `  adapter_refs: [],`,
    `  metadata: {},`,
    `  current_state: "Unknown",`,
    "}",
  ];
  return lines.filter((l): l is string => l !== undefined).join("\n");
}
