// ============================================================
// Check Scheduler — Build 1
// ============================================================
//
// HOW TO READ THIS FILE (for non-coders):
// Everything before this file (adapters, state-engine,
// dependency-evaluator, incident-engine) is pure reasoning: given
// some input, produce some output, with no idea of time or of
// "when" anything runs. This file is the clock. It decides WHEN to
// poll each device, runs the right adapter, and feeds the result
// through the rest of the pipeline in the right order:
//
//   adapter -> state-engine (per device, raw state)
//           -> dependency-evaluator (across all devices, displayed state)
//           -> incident-engine (across all devices, incidents)
//           -> persistence + WebSocket broadcast
//
// DESIGN NOTE - why a fixed tick instead of one timer per check:
// Checks can each have their own interval_seconds, but
// dependency-evaluator and incident-engine are both meant to run
// "once per poll cycle" over the FULL picture of every device, not
// once per individual check result. So instead of one setInterval
// per check, there's a single fast tick (default 10s). Each tick
// asks every enabled check "are you due yet?" and only actually
// polls the ones that are. If nothing was due, the tick is a no-op -
// dependency/incident evaluation only re-runs when something could
// actually have changed.
// ============================================================

import type { Check, Device, DependencyRecord, Integration, Observation } from "./domain-model";
import { runIcmpCheck } from "./icmp-adapter";
import { runUnifiDeviceCheck, type UnifiIntegrationConfig } from "./unifi-adapter";
import { runSnmpCheck, type SnmpIntegrationConfig } from "./snmp-adapter";
import { evaluateDeviceState, DEFAULT_HYSTERESIS_CONFIG, type HysteresisConfig } from "./state-engine";
import { applyDependencyEvaluation } from "./dependency-evaluator";
import {
  evaluateIncidents,
  DEFAULT_INCIDENT_ENGINE_CONFIG,
  type IncidentEngineConfig,
  type Incident,
} from "./incident-engine";
import type { RackWatchStore } from "./persistence";
import type { StateTransitionEvent, DeviceStateRecord } from "./domain-model";

const DEFAULT_TICK_MS = 10_000;
const DEFAULT_ICMP_RETRIES = 2; // Check (domain-model.ts) has no retries field - this is scheduler-level policy, not spec-derived
const DEFAULT_SNMP_RETRIES = 1; // net-snmp's own default - baseline SNMP is polled frequently, so a slow retry storm costs more than the next tick

export interface CycleResult {
  displayedStates: Map<string, DeviceStateRecord>;
  transitionEvents: StateTransitionEvent[];
  incidents: Incident[];
  polledAt: string;
}

export interface SchedulerOptions {
  devices: Device[];
  checks: Check[];
  dependencies: DependencyRecord[];
  integrations: Integration[];
  store: RackWatchStore;
  onCycleComplete: (result: CycleResult) => void;
  tickIntervalMs?: number;
  hysteresisConfig?: HysteresisConfig;
  incidentConfig?: IncidentEngineConfig;
  now?: () => number; // injectable for tests
}

export class CheckScheduler {
  private readonly devicesById: Map<string, Device>;
  private readonly integrationsById: Map<string, Integration>;
  private readonly lastRunAt = new Map<string, number>(); // check_id -> epoch ms
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false; // guards against overlapping ticks if one runs long

  constructor(private readonly options: SchedulerOptions) {
    this.devicesById = new Map(options.devices.map((d) => [d.device_id, d]));
    this.integrationsById = new Map(options.integrations.map((i) => [i.integration_id, i]));
  }

  start(): void {
    const intervalMs = this.options.tickIntervalMs ?? DEFAULT_TICK_MS;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    void this.tick(); // run once immediately rather than waiting a full tick on startup
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.ticking) return; // previous tick still running (e.g. a slow ICMP timeout) - skip, don't stack up
    this.ticking = true;
    try {
      await this.runDueChecks();
    } catch (err) {
      console.error("[scheduler] tick failed", err);
    } finally {
      this.ticking = false;
    }
  }

  private async runDueChecks(): Promise<void> {
    const now = this.options.now ? this.options.now() : Date.now();
    const dueChecks = this.options.checks.filter((c) => c.enabled && this.isDue(c, now));
    if (dueChecks.length === 0) return;

    const { store } = this.options;
    const rawStates = store.loadAllRawStates();
    const transitionEvents = new Map<string, StateTransitionEvent>();

    for (const check of dueChecks) {
      this.lastRunAt.set(check.check_id, now);

      const device = this.devicesById.get(check.device_id);
      if (!device) {
        console.error(`[scheduler] check ${check.check_id} references unknown device ${check.device_id}`);
        continue;
      }

      let observation: Observation;
      try {
        observation = await this.runCheck(check, device);
      } catch (err) {
        console.error(`[scheduler] check ${check.check_id} threw unexpectedly`, err);
        continue;
      }

      const previousState = rawStates.get(device.device_id);
      const previousWindow = store.loadWindow(device.device_id);
      const result = evaluateDeviceState(
        observation,
        previousState,
        previousWindow,
        this.options.hysteresisConfig ?? DEFAULT_HYSTERESIS_CONFIG
      );

      rawStates.set(device.device_id, result.state);
      store.saveRawState(result.state);
      store.saveWindow(result.window);

      if (result.transitionEvent) {
        transitionEvents.set(device.device_id, result.transitionEvent);
        store.appendTransitionEvent(result.transitionEvent);
      }
    }

    // Cross-device reasoning always runs over the FULL current raw-state
    // picture (every device, not just the ones polled this tick) - a
    // device polled 3 ticks ago whose upstream just failed still needs
    // to be recast to Dependency now, even though it wasn't re-checked
    // this cycle.
    const depResult = applyDependencyEvaluation({
      states: rawStates,
      transitionEvents,
      dependencies: this.options.dependencies,
    });

    for (const state of depResult.states.values()) {
      store.saveDisplayedState(state);
    }

    const openIncidents = store.loadOpenIncidents();
    const incidentResult = evaluateIncidents(
      {
        states: depResult.states,
        transitionEvents: depResult.transitionEvents,
        openIncidents,
      },
      new Date(now).toISOString(),
      this.options.incidentConfig ?? DEFAULT_INCIDENT_ENGINE_CONFIG
    );

    for (const incident of incidentResult.incidents) {
      store.saveIncident(incident);
    }

    this.options.onCycleComplete({
      displayedStates: depResult.states,
      transitionEvents: Array.from(depResult.transitionEvents.values()),
      incidents: incidentResult.incidents,
      polledAt: new Date(now).toISOString(),
    });
  }

  private isDue(check: Check, now: number): boolean {
    const last = this.lastRunAt.get(check.check_id);
    if (last === undefined) return true; // never run - due immediately
    return now - last >= check.interval_seconds * 1000;
  }

  private async runCheck(check: Check, device: Device): Promise<Observation> {
    switch (check.type) {
      case "icmp_ping": {
        const address = device.addresses.find((a) => a.type === "ip" || a.type === "hostname")?.value;
        if (!address) {
          throw new Error(`device ${device.device_id} has no ip/hostname address for icmp check ${check.check_id}`);
        }
        return runIcmpCheck({
          device_id: device.device_id,
          address,
          timeout_seconds: check.timeout_seconds,
          retries: DEFAULT_ICMP_RETRIES,
        });
      }

      case "unifi_device_status": {
        if (!check.integration_id) {
          throw new Error(`check ${check.check_id} is type unifi_device_status but has no integration_id`);
        }
        const integration = this.integrationsById.get(check.integration_id);
        if (!integration) {
          throw new Error(`check ${check.check_id} references unknown integration ${check.integration_id}`);
        }
        const adapterRef = device.adapter_refs.find((r) => r.integration_id === check.integration_id);
        if (!adapterRef) {
          throw new Error(
            `device ${device.device_id} has no adapter_ref for integration ${check.integration_id}`
          );
        }
        return runUnifiDeviceCheck(
          integration.config as unknown as UnifiIntegrationConfig,
          device.device_id,
          adapterRef.external_id
        );
      }

      case "snmp_reachability": {
        const address = device.addresses.find((a) => a.type === "ip" || a.type === "hostname")?.value;
        if (!address) {
          throw new Error(`device ${device.device_id} has no ip/hostname address for snmp check ${check.check_id}`);
        }
        if (!check.integration_id) {
          throw new Error(`check ${check.check_id} is type snmp_reachability but has no integration_id`);
        }
        const integration = this.integrationsById.get(check.integration_id);
        if (!integration) {
          throw new Error(`check ${check.check_id} references unknown integration ${check.integration_id}`);
        }
        const snmpConfig = integration.config as unknown as SnmpIntegrationConfig;
        return runSnmpCheck({
          device_id: device.device_id,
          address,
          community: snmpConfig.community,
          version: snmpConfig.version,
          port: snmpConfig.port,
          timeout_seconds: check.timeout_seconds,
          retries: DEFAULT_SNMP_RETRIES,
        });
      }

      default:
        throw new Error(`unsupported check type: ${check.type}`);
    }
  }
}
