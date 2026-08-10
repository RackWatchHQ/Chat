# RackWatch

Vendor-agnostic network/infrastructure monitoring appliance for professional AV and broadcast
environments (OB trucks, flypacks, fixed facility racks) — not general IT. Real deployments mix
switch vendors (Netgear, Juniper, Arista, Cisco, Ubiquiti) within the same truck or facility, so
the monitoring layer never assumes a single manufacturer's API.

## Two active tracks — don't conflate them

- **v0.9 spec** — the locked, sellable-product architecture (CM5 Lite, secure element,
  bespoke carrier board, single-SKU commercial model). Reference: `@docs/RackWatch_Spec_v0.9_Summary.md`
- **MVP build** — a deliberate fork for client-site validation only (Pi 5, off-shelf kit,
  no secure element, no power-loss hardware). Reference: `@docs/RackWatch_MVP_Brief_Draft.md`

If a task doesn't specify which track it's for, ask rather than assume — hardware and scope
differ between them, and changes to one must never silently bleed into the other's docs.

**MVP success bar (confirmed):** operational validation — the client's own team uses and
trusts it unprompted — not just "does the state engine work" or "does this justify more
funding." See the brief for the full criteria.

## Stack

TypeScript / Node.js throughout. React dashboard. SQLite in WAL mode for local state
(chosen specifically for power-loss resilience — keep this even where MVP drops the
power-loss *hardware*). Domain logic files already exist and define the contracts everything
else builds on:

`domain-model.ts` → `icmp-adapter.ts` / `unifi-adapter.ts` → `state-engine.ts` →
`dependency-evaluator.ts` → `incident-engine.ts`

Each stage depends on contracts established by the prior one — build and extend in that order.

## Core architectural rules (do not violate silently)

- **Adapters never assign Device State, open/close Incidents, or determine UI presentation.**
  They only turn raw results into `Observation`s. The State Engine is the *only* place that
  writes `current_state`.
- **Anti-churn hysteresis is system-wide:** 3 consecutive failures to escalate, 2 consecutive
  successes to recover, plus incident closure stability windows. Don't add an evidence path
  that bypasses this.
- **LLDP/topology data annotates, never suppresses escalation.** Inferred dependency links can
  explain state but must never block a Critical transition. Retraction logic only removes what
  the topology service itself created as `Inferred` — never touches human-promoted `Configured`
  or `Verified` dependencies.
- **NRE vs. per-unit cost are tracked separately** in any hardware/BOM work — NRE is one-time
  sunk cost, per-unit cost is the number that matters long-run.

## Working style

- **Rationale before code.** Explain the "why" and get confirmation before producing artefacts
  or locking in a design decision — especially anything touching the v0.9/MVP split above.
- Field-serviceability matters for v0.9 (not MVP): every component an OB engineer might need to
  replace should be sourceable from mainstream electronics/broadcast distribution.
- Keep documentation current at session end rather than letting it drift from what's actually
  built.

## Useful context, not enforced rules

- Reference deployments: Build1 (Ubiquiti, internal), Build0 (Netgear M4250s)
- Licence tier naming: RWC25–RWC500 (not relevant to MVP work)
- `.docx` spec editing workflow (v0.9 docs only): unzip → merge_runs.py → targeted XML
  str_replace → zip -Xr → office/validate.py --original → soffice.py PDF render
