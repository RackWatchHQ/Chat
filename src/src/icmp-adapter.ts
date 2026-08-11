// ============================================================
// ICMP Adapter — Build 1 (spec 8.11)
// ============================================================
//
// HOW TO READ THIS FILE (for non-coders):
// This is the simplest possible Adapter: it pings a device and
// turns the raw result into an Observation, using the exact
// shape defined in domain-model.ts. It does NOT decide whether
// the device is healthy - that judgment belongs to the State
// Engine, which hasn't been built yet. This file's only job is
// "ping -> Observation."
//
// Per spec 8.9, Adapters are prohibited from:
//   - assigning final Device State
//   - opening or closing Incidents
//   - determining UI presentation
// This file does none of those things - there is no DeviceState
// logic anywhere below.
// ============================================================

import { exec } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import type { Observation, AdapterPlugin, AdapterCheckContext } from "./domain-model";

const execAsync = promisify(exec);

// ---- Configuration for one ping check ----
// Mirrors the fields of the Check shape (domain-model.ts) that
// this adapter actually needs to do its job.

export interface IcmpCheckConfig {
  device_id: string;        // which Device this check is about (becomes Observation.target)
  address: string;          // IP address or hostname to ping
  timeout_seconds: number;  // per-attempt timeout (8.11: "controlled timeout and retry behaviour")
  retries: number;          // number of ping attempts before reporting unreachable
}

const SCHEMA_VERSION = "1.0.0"; // DM-008: observation schema versioned independently

// ---- The adapter's one job: ping, and report what happened ----

export async function runIcmpCheck(config: IcmpCheckConfig): Promise<Observation> {
  const { device_id, address, timeout_seconds, retries } = config;
  const startedAt = Date.now();

  const result = await pingHost(address, timeout_seconds, retries);

  return {
    observation_id: randomUUID(),
    timestamp: new Date().toISOString(),
    target: device_id,
    source: "icmp-adapter",           // 8.9: an Adapter identifies itself as the source
    type: "icmp_reachability",         // matches the type named in the spec's 5.3 evidence table
    result,                             // raw, uninterpreted - see IcmpResult below
    quality: "corroborating",           // 5.3: ICMP alone is useful but not authoritative on its own
    freshness_seconds: Math.round((Date.now() - startedAt) / 1000),
    schema_version: SCHEMA_VERSION,
  };
}

// ---- The raw result shape this adapter produces ----
// This ends up in Observation.result above. Deliberately plain and
// uninterpreted - "reachable: true/false" is a fact, not a verdict.

export interface IcmpResult {
  reachable: boolean;
  attempts_made: number;
  successful_attempts: number;
  round_trip_ms?: number;   // average RTT across successful attempts, if any
  error?: string;           // populated only on an unexpected failure (not a normal timeout)
}

// ---- Low-level ping execution ----
// Uses the system `ping` command, available by default on the
// Debian-based OS the spec targets (4.6). Never throws on a normal
// timeout - only on something unexpected (bad hostname, missing
// binary). A failed ping is data, not an exception: the same
// principle spec 8.11 states for UniFi unavailability applies here.

async function pingHost(
  address: string,
  timeoutSeconds: number,
  retries: number
): Promise<IcmpResult> {
  let successfulAttempts = 0;
  let totalRttMs = 0;
  let attemptsMade = 0;

  try {
    for (let attempt = 0; attempt < retries; attempt++) {
      attemptsMade++;
      const rtt = await singlePing(address, timeoutSeconds);
      if (rtt !== null) {
        successfulAttempts++;
        totalRttMs += rtt;
      }
    }

    return {
      reachable: successfulAttempts > 0,
      attempts_made: attemptsMade,
      successful_attempts: successfulAttempts,
      round_trip_ms:
        successfulAttempts > 0
          ? Math.round(totalRttMs / successfulAttempts)
          : undefined,
    };
  } catch (err) {
    // Something went wrong beyond a normal timeout (bad hostname, ping
    // binary missing, etc). This is evidence of adapter trouble, not
    // device trouble - spec 5.8 draws that distinction explicitly.
    return {
      reachable: false,
      attempts_made: attemptsMade,
      successful_attempts: successfulAttempts,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Runs one ping attempt. Returns round-trip time in ms, or null on timeout.
async function singlePing(address: string, timeoutSeconds: number): Promise<number | null> {
  const command = `ping -c 1 -W ${timeoutSeconds} ${address}`;

  try {
    const { stdout } = await execAsync(command, { timeout: (timeoutSeconds + 1) * 1000 });
    const match = stdout.match(/time[=<]([\d.]+)\s*ms/i);
    return match ? parseFloat(match[1]) : null;
  } catch {
    // A non-zero exit code from `ping` just means "no response" - a
    // normal, expected outcome, not an error condition.
    return null;
  }
}

// ---- Formal plugin conformance (v0.9 spec §4.4) ----
// Wraps runIcmpCheck above to satisfy the AdapterPlugin contract
// (domain-model.ts), with no change to its behaviour. ICMP is the
// only one of the three reference adapters that needs neither a
// configured Integration nor an AdapterReference - it addresses the
// device directly by IP/hostname, with no vendor API in between.

const PLUGIN_DEFAULT_RETRIES = 2; // mirrors scheduler.ts's own DEFAULT_ICMP_RETRIES - Check has no retries field
                                    // (domain-model.ts); duplicated rather than imported so this plugin is
                                    // self-contained for a loader that doesn't go through scheduler.ts

export const icmpAdapterPlugin: AdapterPlugin = {
  adapter_type: "icmp",
  produces: ["icmp_reachability"],
  requires_integration: false,
  requires_adapter_reference: false,

  async runCheck(context: AdapterCheckContext): Promise<Observation> {
    if (!context.address) {
      throw new Error(`icmp adapter plugin requires an address for device ${context.device_id}`);
    }
    return runIcmpCheck({
      device_id: context.device_id,
      address: context.address,
      timeout_seconds: context.check.timeout_seconds,
      retries: PLUGIN_DEFAULT_RETRIES,
    });
  },
};
