// ============================================================
// Discovery Scheduler — Prototype Phase
// ============================================================
//
// Periodic (30 min) + on-demand ("sweep now") invocation of
// runDiscoverySweep (discovery-adapter.ts), per
// docs/discovery-adapter-scope.md §4's confirmed decisions. A small
// standalone module, not a class extending/mirroring CheckScheduler -
// there's no per-Check due-ness tracking to do here, just "sweep
// every configured Monitoring subnet on a timer, plus on demand."
// ============================================================

import { runDiscoverySweep, type DiscoverySweepConfig, type DiscoveredHost } from "./discovery-adapter";

const SWEEP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes - the scope doc's confirmed decision, not provisional

export interface DiscoverySchedulerOptions {
  sweepConfig: DiscoverySweepConfig;
  loadPreviousHosts: () => DiscoveredHost[];
  onSweepComplete: (hosts: DiscoveredHost[]) => void;
  intervalMs?: number; // overridable for tests - never used in production
}

export interface DiscoveryScheduler {
  start(): void;
  stop(): void;
  // Runs a sweep immediately, independent of the 30-minute clock.
  // Never disrupts the next scheduled run's timing - the interval
  // timer below is never touched by this, only by start()/stop().
  sweepNow(): Promise<DiscoveredHost[]>;
}

export function createDiscoveryScheduler(options: DiscoverySchedulerOptions): DiscoveryScheduler {
  const intervalMs = options.intervalMs ?? SWEEP_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<DiscoveredHost[]> | undefined;

  // Shared by both the scheduled tick and sweepNow(). Overlap guard:
  // if a sweep is already running (scheduled or manual), a second
  // caller piggybacks on the SAME in-flight promise rather than
  // kicking off a redundant concurrent sweep - two sweeps racing on
  // the same OS ping/ARP cache at once would just be wasted work, not
  // better data.
  function runSweep(): Promise<DiscoveredHost[]> {
    if (inFlight) return inFlight;

    inFlight = (async () => {
      try {
        const previous = options.loadPreviousHosts();
        const hosts = await runDiscoverySweep(options.sweepConfig, previous);
        options.onSweepComplete(hosts);
        return hosts;
      } finally {
        inFlight = undefined;
      }
    })();

    return inFlight;
  }

  return {
    start(): void {
      timer = setInterval(() => {
        void runSweep().catch((err) => console.error("[discovery-scheduler] scheduled sweep failed", err));
      }, intervalMs);
      // Run once immediately rather than waiting a full interval on
      // startup - same convention CheckScheduler already follows.
      void runSweep().catch((err) => console.error("[discovery-scheduler] initial sweep failed", err));
    },

    stop(): void {
      if (timer) clearInterval(timer);
    },

    sweepNow(): Promise<DiscoveredHost[]> {
      return runSweep();
    },
  };
}
