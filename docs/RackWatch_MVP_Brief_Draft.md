# RackWatch MVP Brief — Draft / Discussion Starting Point

**Status:** Not locked. This is a working document to scope a single-unit MVP for deployment
at a funded client site, to validate the monitoring/state-engine concept ahead of committing
to the full v0.9 productised hardware.

**Relationship to the v0.9 spec:** This is a deliberate *fork*, not a revision. RWS-001 /
RWS-002 and the v0.9 Summary remain the reference for the sellable product (CM5, secure
element, e-ink via carrier board, power-loss hardware, single-SKU commercial model). Nothing
here changes those documents. Once the concept is validated, hardware decisions get
re-evaluated for production — some MVP shortcuts (see §4) are explicitly not meant to survive
into the shipped product.

---

## 1. Purpose

Get a real, working unit into the client site fast and cheaply enough to validate that
RackWatch's vendor-agnostic state engine and dashboard actually solve the problem, while
funding is in place — without waiting on carrier board design/NRE or a hardware partner
decision.

## 2. What "proving the concept" means here

**Confirmed primary bar: operational validation.** Not "does the state engine work" (that's
a precondition, not the goal) and not yet "does this justify continued funding" (a later,
higher bar). The MVP succeeds if the client's own team actually uses and trusts it —
concretely:

- Someone at the site checks the dashboard unprompted, without Ric needing to point them at it
- During a real fault, the team references RackWatch's state/incident view rather than
  falling back entirely to their existing troubleshooting habits
- Alerts and state changes are trusted enough to be acted on, not routinely double-checked
  against another source first
- The e-ink identity panel is useful to whoever's physically on-site (validates that specific
  design bet, not just the software)
- The system runs and is usable without Ric present to explain or babysit it

**What would NOT count as validation:** a single positive demo reaction: technical uptime with
nobody actually looking at it; Ric personally checking it works rather than the client team
doing so.

**Timeframe:** not yet decided — how long the MVP runs at the client site before an answer is
needed is still open. The criteria above don't depend on a fixed date; they're about what
"being used and trusted" looks like whenever the point of assessment arrives.

**Deliberately not required to prove yet:** fleet licensing/entitlement, anti-clone identity,
field-serviceability sourcing chain, power-loss survivability under abrupt outage, or a case
for continued funding (§4 covers what's out of scope for this build).

## 3. Hardware — MVP configuration

Fixed install, mains power, no shipping/vibration exposure — all off-the-shelf components,
no bespoke carrier board.

| Component | MVP choice | Notes |
|---|---|---|
| Compute | Raspberry Pi 5 | CM5's hot-swap/2036-lifecycle rationale doesn't apply to a single research unit |
| Storage | **Confirmed:** same M.2 SSD + JMS583 USB3 bridge board as v0.9, connected to Pi 5 via a standard USB3 cable (not the locking USB-C variant — not needed for a fixed install) | Reuses proven kit. Also sidesteps a possible PCIe lane conflict with the 2.5GbE HAT if it uses the same FPC connector — worth checking, but USB3 storage avoids the question either way, same as it did on CM5 |
| Networking | **Confirmed:** Waveshare PCIe TO 4-CH 2.5G ETH Board (B), connects via Pi 5's 16-pin PCIe FPC cable | Same 4-port count as the v0.9 HAT. Confirms the PCIe lane-sharing concern flagged for storage is real — this board uses the same PCIe interface an NVMe HAT would, which is why USB3 storage is the right call here, not just a convenient one |
| Front panel — e-ink | **Confirmed:** Waveshare 2.9inch e-Paper Module, 296×128, 4 greyscale, SPI | Driver-board version (not raw panel) — matches v0.9 spec. 8-pin cable to GPIO, no 40-pin HAT needed, so driver board can sit wherever's convenient inside the case |
| Front panel — RGB LED | **Confirmed:** WS2812B, bare 5050 SMD package, single GPIO data pin | No PCA9633 driver chip needed — addressable driver is built into the LED package. See §6a for light pipe pairing and footprint. |
| Secure element (ATECC608C) | **Omitted** | Not needed for a single non-commercial research unit |
| Power-loss hardware (brownout detect, supercaps) | **Omitted** | Client site confirmed standard mains, no special protection needed |
| Power-loss *software* | **Kept** — SQLite WAL mode | Already in the code, zero cost to keep, worth retaining as good practice regardless |
| Enclosure | **Confirmed:** Penn Elcom R2110/1UK — 1U, 300mm deep, 3mm black aluminium front panel (removable) | Front panel drills separately from the box — cleaner cuts, low cost if a hole goes wrong. 3mm aluminium is easily hand-drillable for all cutouts (light pipe, e-ink window, EtherCon, button) |

## 4. Explicitly deferred from v0.9 (not being validated by this MVP)

- Anti-clone identity / secure element trust chain (§6 of v0.9 spec)
- Power-loss resilience hardware (brownout + supercap) — §3.7
- Single hardware SKU / entitlement-bound licensing model — §2.3
- Field-serviceability sourcing constraints (bespoke carrier board is the only non-sourceable
  part in v0.9 — irrelevant here since there is no carrier board)
- Modular rear power plate / dual-AC / AC+DC redundancy — §3.5

## 5. Software — build split

Everything from `domain-model.ts` through `incident-engine.ts` is hardware-agnostic and
carries over to the MVP unchanged — this is the main reason the pivot is low-risk.

| Piece | Owner | Notes |
|---|---|---|
| Domain logic, state engine, dependency evaluator, incident engine | **Already built** | No change needed for MVP hardware |
| SNMP baseline adapter | Claude Code | New — needed per §4.1 of v0.9 spec regardless of MVP/production |
| Vendor adapter plugin interface | Claude Code | Formalise existing Integration/AdapterReference/Observation types |
| SQLite/WAL persistence layer | Claude Code | Wiring existing shapes to real tables |
| WebSocket push to dashboard | Claude Code | Well-trodden pattern |
| React dashboard | Claude Code | Build out from existing prototype (`switch-dashboard.jsx`) |
| e-ink companion service | Claude Code (draft) + Ric (hands-on validation) | Small Python process owning the panel (Waveshare libs are Python/C), Node/TS app sends render requests to it over a local socket/queue. GPIO pinout confirmation and real refresh behaviour need physical validation — can't be proven from code alone |
| RGB LED (GPIO PWM) | Claude Code | Simple if driven directly rather than via I2C chip |
| Cloud backend / entitlement | **Not needed for MVP** | Single unit, no licensing to enforce yet |

## 6a. RGB LED + light pipe pairing — confirmed

**LED:** WS2812B, bare 5050 SMD package (5.0mm × 5.0mm), not the Pi Hut breadboard-friendly
breakout — the bare package sits flatter/lower, giving a closer optical match to the light
pipe than a breakout board would. Single GPIO data pin, driven via the same `rpi_ws281x`
Python library approach as the e-ink companion service (§5) — no per-channel resistor sizing,
no driver chip needed.

**Light pipe:** Mentor 1216.1001 (1000µm fibre, 150mm) or 1216.1002 (2000µm fibre, 80mm) —
flexible PCB-mount light guide, housing held by two press-in lugs, from the same manufacturer
family already specified for the front panel in the v0.9 spec (§3.8).

**Confirmed PCB footprint** (from Mentor's official mounting drawing):
- Two mounting holes, **Ø2.4mm**, spaced **7.5mm** apart (centre-to-centre)
- LED positioned per the 1.2mm / 2.4mm / 4.5mm reference offsets on the layout drawing
- Front panel cutout: **Ø4mm** (1216.1001) or **Ø3.6mm** (1216.1002)
- Full drawing: https://docs.rs-online.com/5212/0900766b813f6e22.pdf

**Compatibility note:** Mentor's datasheet specifies these light guides "have to be powered by
SMD TOPLEDs" (an OSRAM package family) for guaranteed optical performance. WS2812B's 5050
package is a different but similarly flat/compact SMD footprint — not officially blessed by
Mentor, but a reasonable bet for MVP purposes given the cost of testing is low. If coupling
turns out poor, the fallback is a plain (non-addressable) OSRAM TOPLED RGB LED, at the cost of
going back to 3-channel GPIO PWM drive with resistors instead of single-wire control.

**Sourcing note:** buy the WS2812B as a bare/cuttable SMD part (sold on reels or as loose cut
singles), not the breadboard-friendly breakout — hand-soldering a bare 5050 package is fiddly
but keeps the LED's optical footprint closest to what the light pipe expects.

## 6. Open items / decisions still needed

- [ ] Test-fit WS2812B against Mentor 1216.1001/1002 light pipe before committing to full order
- [ ] e-ink panel mounting on the 3mm aluminium front panel — active display area is 66.89 ×
      29.05mm; protect the glass from panel flex, keep the 8-pin flex cable routing clear,
      consider a clear window over the cutout rather than a bare hole
- [ ] Decide how long the MVP runs at the client site before assessing operational validation
      (§2) — no fixed date needed yet, but worth pinning down once the build's underway

## 7. Explicitly out of scope for this document

- Production/shipped-unit hardware decisions (stay in v0.9)
- Commercial model, licensing tiers, GBE/BVM partner decision — unaffected by this MVP
