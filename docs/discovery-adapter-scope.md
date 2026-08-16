# Discovery Adapter — Scope Note (Prototype Phase)

*Companion to icmp-adapter.ts / unifi-adapter.ts. Written for review before any code gets written.*

---

## 1. What this is, in plain terms

Every adapter built so far answers a question about **one already-known device**: "is this specific IP reachable?", "what does UniFi say about this specific switch?" This is different — it's the piece that goes and finds devices RackWatch doesn't know about yet, and reports back enough about each one that a human can say "yes, that's the core switch" instead of "yes, that's a MAC address."

It does **not** decide anything, assign state, or add a device to the monitored list on its own — same rule every other adapter already follows (spec 8.9). It just reports what it found. A human — or, later, a config UI — turns a discovery into an actual monitored `Device`.

---

## 2. The three tiers, and what each one actually buys you

| Tier | What it produces | New dependency | Estimated effort |
|---|---|---|---|
| **1 — Sweep** | IP + MAC for every live host on the subnet | None | ~0.5 day |
| **2 — Vendor tag** | Tier 1 + manufacturer name (e.g. "Netgear") from the MAC's OUI prefix | Static offline OUI table (bundled, no network call) | ~free, same 0.5 day |
| **3 — Identify** | Tier 1+2 + `sysDescr`, `sysObjectID`, `sysName`, `sysUpTime` from any device with SNMP enabled — i.e. "Netgear M4250-9G1F, up 14 days" instead of just "Netgear" | `net-snmp` npm package | ~1 day |

**Recommendation: build through Tier 3 for the prototype.** Tier 1 alone isn't demo-credible — a list of MAC addresses doesn't tell a peer anything. Tier 3 is what turns the sweep into "here's what's actually on this network," which is the thing worth showing.

**Explicitly deferred, not forgotten:**
- **Interface table walk** (`ifTable`/`ifXTable` — per-port speed, link status, description). Genuinely valuable later — it's the foundation for inferring topology (which port a device is plugged into) without a human configuring it — but it's a bigger, fiddlier piece of SNMP work (a table walk vs. a single scalar query) and isn't what makes the prototype land. Fast-follow candidate once the sweep + dashboard are proven.
- **Active TCP port scanning.** More intrusive on a live production network than a ping+SNMP sweep, noisier signal, and not something to run automatically on a truck mid-show. Leave out entirely, or make it an explicit opt-in diagnostic much later.
- **Full vendor adapter matching** (Section 4.2's "downloadable adapter library" — auto-detecting that a fingerprint matches, say, the UniFi adapter and offering to install it). That's real, separate work for once there's more than one or two vendor adapters to match against.

---

## 3. How it fits the existing shape

No changes needed to `domain-model.ts`'s core types, the state engine, dependency evaluator, or incident engine — this sits entirely upstream of all of them, same as the existing adapters. One new addition:

```ts
// A DISCOVERED host is not yet a monitored Device. It has no device_id,
// no Checks, no dependencies - it's a candidate, not a conclusion.
// Nothing here is a State Engine input; discovery never touches
// current_state.

export interface DiscoveredHost {
  ip: string;
  mac?: string;                    // absent if ARP entry expired before read
  vendor_guess?: string;           // from OUI lookup, e.g. "Netgear"
  snmp?: {
    sys_descr?: string;
    sys_object_id?: string;
    sys_name?: string;
    uptime_seconds?: number;
    community_used?: string;       // which community string worked, for diagnostics
  };
  first_seen: string;              // ISO-8601
  last_seen: string;
}
```

This slots straight into the existing "unmonitored device detection" scaffolding already built (MAC-based identity, sustained-presence threshold, self-clearing) — that piece was built expecting exactly this kind of input, it just hasn't had a real discovery source feeding it yet.

---

## 4. Decisions (confirmed)

- **Subnet scope.** Sweep whatever's live on all configured Monitoring interfaces — up to 4 ports, not just the 2 active by default. No exclusions defined yet; revisit if a site needs a network deliberately left untouched (e.g. Dante audio).
- **SNMP community strings.** Try `public` automatically first (the near-universal v1/v2c default in this market), then any additional strings configured for the site, first success wins. A host that answers to none of them still appears from the ARP sweep alone (IP/MAC/OUI vendor), just without SNMP detail — never blocks or fails the sweep. SNMP v3 out of scope for the prototype — different, heavier protocol, rarely seen on this class of gear.
- **Sweep frequency.** Periodic background sweep every 30 minutes, plus a manual "sweep now" trigger for adding something mid-event without waiting.
- **Results view.** Deliberately minimal for the prototype: a plain list (IP, MAC, vendor guess, SNMP identity if found, first/last seen) with a manual "add as monitored device" action. The fuller "here's one we found — tell us what it is" classification workflow stays parked as Config UI work, not pulled forward here.

---

## 5. Dependencies

| Need | Approach | New install? |
|---|---|---|
| SNMP queries (Tier 3) | `net-snmp` npm package | Yes |
| MAC → vendor name (Tier 2) | Small OUI lookup package (e.g. `oui`), or bundle the IEEE's public OUI registry file directly | Yes (or a bundled data file, no package) |
| ARP table reading | Parse `arp -a` / read `/proc/net/arp` — same shell-out pattern the ICMP adapter already uses | No |
| Subnet → address list (up to 4 interfaces) | Hand-written, or a small CIDR helper (e.g. `netmask`) to avoid hand-rolling the math | Optional |

None of this moves the ~2-day estimate below — `net-snmp` was already assumed; the rest are small enough not to shift it.

## 6. Total estimate

**~2 days of Claude Code assembly time** for Tiers 1–3 (sweep, OUI vendor tag, SNMP identification), plus review/gap-analysis passes either side, in line with how every other adapter in this codebase has been built. Interface-table walk and full adapter-matching are separate, later pieces — not included in this estimate.
