**RackWatch — Spec v0.9**

*Consolidated hardware, security, and commercial-model decisions — including software stack outline for developer scoping*

Working reference document — compiled from design discussion, August 2026

# 1. Executive summary

RackWatch Core is a physical monitoring appliance for network switches and broadcast/AV infrastructure, targeted at the professional AV and broadcast market — OB trucks, flypacks, and fixed facility racks — rather than general IT. Deliberately vendor-agnostic: real-world deployments mix Netgear, Juniper, Arista, Cisco, and other switch vendors within the same truck or facility, so the monitoring layer cannot assume a single manufacturer's API. The commercial model separates hardware (sold outright, not financed into the subscription) from a block-based device-count licence (RWC25 through RWC500, with a custom Enterprise tier above that). A single hardware SKU now covers every licence tier: capacity is a software entitlement bound to a hardware-rooted identity, not a hardware variant. The whole design leans on one repeated principle — minimise bespoke parts, maximise field-serviceability, and keep everything an OB engineer might need to replace sourceable from mainstream electronics or broadcast distribution. This version adds the chosen software stack for developer scoping (Section 9) and locks the remaining open hardware specs (compute module configuration, storage capacity, light pipe).

# 2. Commercial model

## 2.1 Licence tiers

Block-based licensing, following the precedent set by Audinate's Dante Domain Manager in this same market — customers buy the tier that covers their device count and round up (e.g. 90 devices buys the RWC100 block), rather than metering per exact device.

| **Tier** | **Devices** | **Indicative annual** | **£/device/yr** |
| --- | --- | --- | --- |
| RWC25 | 25 | £800–£1,000 | £32–£40 |
| RWC50 | 50 | £1,400–£1,700 | £28–£34 |
| RWC150 | 150 | £3,200–£3,800 | £21–£25 |
| RWC200 | 200 | £3,800–£4,500 | £19–£22 |
| RWC250 | 250 | £4,300–£5,000 | £17–£20 |
| RWC500 | 500 | TBC — pricing not yet modelled | TBC |
| Enterprise | 500+ | Custom quote | ~£14–£17 |

*Maximum tier raised from 250 to 500 devices — hardware headroom (CPU, RAM, storage, network bandwidth) comfortably supports the doubled ceiling with no BOM change. The one dependency this places on the software layer: device polling must run concurrently (a worker pool), not sequentially — a sequential one-at-a-time poll loop risks not completing within the poll interval at 500 devices if a meaningful fraction are timing out. Flagged for the development team as a hard architectural requirement, not an optimisation.*

## 2.2 Hardware pricing

- Hardware sold separately from the licence — a one-time capex purchase, not amortised into the subscription term. Mirrors how Domotz and most AV/broadcast capital equipment is sold, and avoids the churn risk of writing off hardware against a subscription that might be cancelled early.

- Trade price to integrators: ~£1,400–£1,600 (assumes ~£1,000 landed build cost at low volume). Suggested resale/MSRP: ~£2,000–£2,400.

- Optional bundling: hardware discounted or included in exchange for a 3-year licence commitment, offered selectively for larger deals rather than as the default.

## 2.3 Single hardware SKU

- One carrier board, one BOM, across all licence tiers — capacity, monitoring-NIC segment count, and power redundancy are all configuration/entitlement choices, not different hardware builds.

- **NIC segmentation as a lever:** the carrier uses a 4-port 2.5G ETH HAT; 2 of the 4 ports are active by default (Mon A / Mon B), software-assignable to any physical port. Unlocking all 4 as independent monitoring segments is a candidate additional paid entitlement.

- **Power redundancy decoupled from tier:** a modular rear power plate (fixed IEC + a second IEC or a 12V XLR4 plate) lets any customer choose dual-AC or AC+DC redundancy regardless of device-count tier, via a build-time fitment choice rather than a different product.

- **Upgrades are a backend record change:** because licence entitlement is bound to the RackWatch ID rather than baked into firmware, growing from RWC25 to RWC100 is a phone call and an invoice — no truck roll, no reflash.

# 3. Hardware architecture

## 3.1 Compute

- Raspberry Pi Compute Module 5 (CM5), socketed for hot-swap field replacement — an engineer can swap a failed module in minutes without soldering.

- Chosen for: field-replaceability, mature/tried-and-tested silicon, and a manufacturer-committed production lifetime to at least January 2036 (material for a decade-plus broadcast product).

- **Confirmed configuration:** CM5 Lite (no onboard eMMC — redundant given the unit boots from the external USB3 SSD), non-wireless (all monitoring/management traffic is wired), 4GB RAM (comfortable headroom for the state engine's lightweight per-device workload at up to 500 devices; revisit only if real-world profiling shows otherwise).

## 3.2 Storage

- USB3 → M.2 bridge board + SATA/NVMe SSD, fully internal, boots the OS. Chosen over native PCIe NVMe specifically to avoid a lane conflict with the dual-Ethernet HAT (CM5 exposes a single PCIe Gen2 x1 lane).

- USB3 throughput is far beyond what the state engine's small, infrequent writes (rolling evidence windows, state records, transition events) ever need — no meaningful performance trade-off for this workload, at 250 or 500 devices.

- **Confirmed capacity:** 128GB, industrial/wide-temperature-rated. Telemetry footprint stays in the tens-of-MB range even at 500 devices — the real driver is OS + A/B update partitions + log retention + wear margin, not device count. Deliberately not over-specified: 2026 NAND pricing has removed the old "capacity is basically free" assumption, so sized to genuine need rather than headroom nobody will use.

## 3.3 Networking

- Onboard CM5 Gigabit Ethernet → Management port.

- 4-port 2.5GbE PCIe HAT → 2 ports active by default as Monitoring A / B, software-assignable to any physical port (avoids "which port in the dark" mistakes); remaining 2 ports reserved as a future entitlement.

## 3.4 Video

- CM5's native dual HDMI outputs: one direct to a rear HDMI port; the second through a Blackmagic Micro Converter (HDMI→SDI) to a rear SDI port — lets the dashboard patch straight into existing broadcast infrastructure (multiviewers, vision mixers) rather than requiring a separate HDMI monitor.

## 3.5 Power

- PoE evaluated and dropped entirely — 802.3af/at power budgets were tight against the appliance's realistic draw (~10–18W sustained) with little headroom for growth, and AC + 12V DC already cover every real deployment scenario in this market.

- Primary: AC mains via IEC inlet → Mean Well PSU module.

- Secondary: 12V DC via 4-pin XLR — the broadcast-standard power connector (V-mount/Gold-mount batteries, truck DC distribution). Wide-input buck/boost to handle real battery voltage swing (~11–16.8V), with reverse-polarity protection given inconsistent XLR4 pin-out conventions across manufacturers.

- 2-input ideal-diode ORing module (off-the-shelf, Pololu-style part) handles seamless failover between the two sources.

- Modular rear power plate: fixed IEC on one side; a second IEC (dual-AC redundancy) or an XLR4 (AC+DC) plate on the other, fitted at build/order time — configuration choice, not a different product.

## 3.6 Thermal

- Two small PWM-controlled fans, temperature-triggered rather than always-on — near-silent under normal load, full airflow under thermal stress. Preferred over fully fanless given the enclosure's power budget headroom.

## 3.7 Power-loss resilience

Designed specifically against the real failure mode for this market — a breaker throw, not a graceful shutdown:

- Read-only root filesystem; only the small, genuinely mutable state (rolling evidence windows, device state, incident history) lives on a separate writable area.

- That state store uses SQLite in WAL mode — designed specifically to survive power loss mid-write without corruption.

- Brownout-detection on the power stage triggers a fast clean-shutdown script; a small bank of supercapacitors (not a battery) provides the few seconds of hold-up energy needed. Supercapacitors were chosen over a Li-ion battery specifically to avoid UN38.3 lithium-battery shipping/certification overhead for something travelling internationally in flight cases.

## 3.8 Front panel

- RGB LED — echoes overall system status. Mounted directly on the carrier board, read through an off-the-shelf flexible light pipe (no wiring harness, no connector to work loose in transit). Flexible chosen over a fixed/straight pipe — small cost premium, but decouples the viewer's position (centred on the front panel) from the LED's position on the carrier, rather than forcing the two into direct alignment. Confirm routing stays within the part's rated bend radius during enclosure design, as tight bends cost some light transmission and even RGB colour mixing.

- 2.9″ e-ink "Digital Identity Panel" — see Section 7.

- Recessed, long-press power/reboot button — short press triggers clean shutdown, long press forces recovery; recessed and long-press-gated specifically to prevent accidental triggering.

- Tethered USB-C recovery port behind a dust/access flap — physically present but electrically inert (power and data lines gated off by default via a switch IC, only live during a deliberate boot-time recovery check) so it cannot be used to charge a phone or enumerate unexpectedly during normal operation.

## 3.9 Rear panel

IEC · 12V XLR4 · 2× SDI · HDMI · Management NIC · 2× Monitoring NIC (of 4 physical) · recovery USB-C.

# 4. Multi-vendor adapter strategy

Build1 used Ubiquiti's own API as the primary source of device state, with ICMP as a secondary check. Real-world deployments corrected this assumption: Build0 testing uses Netgear M4250 switches, and other OB trucks in the target market run Juniper, Arista, Cisco, and other vendors — often several within the same truck or facility. RackWatch's monitoring layer needs to work across all of them from day one, without assuming any single manufacturer's API is present.

## 4.1 Layered evidence model

- **Permanent baseline, every device, regardless of vendor:** SNMP and ICMP. These never get switched off once a richer adapter is found — they continue running alongside it as an independent, corroborating check.

- **Vendor-specific API adapters (e.g. the existing UniFi adapter) sit on top, not instead of, the baseline:** when a device has a matching vendor adapter, it becomes an additional authoritative-tier source layered over SNMP/ICMP, not a replacement for them. This deliberately preserves the state engine's existing confidence model, which only reaches High confidence when two or more independent sources currently agree (Section 5.4 of the engineering spec) — an API alone, however rich, cannot justify that on its own; the SNMP/ICMP baseline is what makes independent cross-validation possible for every device, not just ones with a matching adapter.

- **SNMP does double duty:** standard fields (sysDescr, sysObjectID) identify vendor and model without needing any vendor-specific adapter, making SNMP both the fallback monitoring signal and the mechanism that detects which richer adapter, if any, should be used.

## 4.2 Downloadable adapter library

The appliance's existing "dial home" entitlement-check connection (Section 8) is extended to also sync a growing library of vendor-specific adapters:

- On detecting a device's vendor/model via SNMP fingerprint, the appliance checks whether a matching adapter is already installed; if not, and one exists in the backend library, it is downloaded and installed automatically.

- New vendor adapters get added to the library over time as the product matures — a unit bought today becomes more capable as coverage grows, without a firmware reflash or hardware change.

- **Commercial tie-in:** this gives the support-contract renewal a second, concrete pitch beyond firmware/security patching — "your library of vendor integrations grows over time" is a tangible, ongoing value proposition, not an abstract one.

## 4.3 Security requirement

- **Adapter packages must be code-signed by RackWatch;** the appliance should only execute adapter code it can verify came from RackWatch. An appliance on a customer's network that downloads and runs new code touching that network (SNMP community strings, vendor API credentials) is a real attack surface if the update channel isn't locked down. This extends the same trust infrastructure already built for device identity (Section 6) rather than requiring a separate mechanism.

## 4.4 Plugin interface

The domain model's existing Integration, AdapterReference, and Observation types already form the right shape for this as a plugin contract. Worth formalising explicitly as "this is how a new vendor adapter gets built and loaded" before handing software development to an external team — see Section 9.

# 5. Field-serviceability

The guiding design constraint throughout: an OB engineer should be able to keep a unit running with parts sourced locally wherever genuinely possible. The only component that cannot be sourced independently of RackWatch is the carrier board itself.

| **Component** | **Source** | **Category** |
| --- | --- | --- |
| Carrier board | RackWatch only | Bespoke |
| CM5 compute module | Pi resellers (RS, Farnell, Digikey) | Specialist retail |
| 4-port 2.5G ETH HAT | Electronics distributors | Specialist retail |
| USB3→M.2 storage bridge + SSD | Any computer retailer | Commodity |
| Mean Well PSU module | Industrial/electronics suppliers | Commodity |
| 2-input ORing (ideal-diode) module | Embedded/Pi ecosystem suppliers | Commodity |
| Fans (PWM) | Any PC/electronics retailer | Commodity |
| Blackmagic Micro Converter (HDMI→SDI) | AV/broadcast dealer — likely already in truck/flypack | Specialist retail |
| e-ink module, RGB LED + light pipe | Electronics distributors | Commodity / specialist |
| ATECC608C secure element | Microchip / distributors (pre-provisioned) | Specialist retail |

# 6. Identity & security

Prompted by a real gap identified mid-design: nothing was stopping a unit being cloned, or a new "appliance" being minted via the recovery USB path.

## 5.1 Three-identity model

- **Serial number:** permanent manufacturing identity, internal to RackWatch only, never shown publicly. Recommended to reuse the ATECC608C's own factory-burned unique serial rather than minting a separate one.

- **RackWatch ID (public):** customer-facing identifier, printed on the unit and shown on the e-ink panel, format RWC-XXXX-XXXX in Crockford Base32 (avoids visually ambiguous characters — important for something read aloud over a radio during an incident), with an added Crockford check symbol to catch mistyped/mis-heard IDs immediately. This is the identifier licence entitlement, support, and device authentication all key off — explicitly never treated as an authentication secret.

- **Private credential:** an asymmetric keypair generated inside a Microchip ATECC608C-TFLXTLS secure element. The private key never leaves the chip and cannot be extracted; only the public key is registered with the RackWatch backend.

## 5.2 Provisioning

- Keypair generation and config-zone locking happen once, at manufacture, via Microchip's Trust Platform Design Suite / Secure Provisioning Service using a RackWatch-owned root CA — each chip's public key is signed by RackWatch at that same factory step, producing a device certificate.

- The recovery-USB flow never touches the secure element's provisioning state — it only restores the OS image.

- Net effect: SSD/disk cloning cannot produce a second valid appliance (the clone can't sign a backend challenge with the original's private key), and unsigned/uncertified hardware cannot self-register for a valid RackWatch ID (closes counterfeiting, not just cloning).

Key-management discipline (root CA storage, intermediate signing key, audit process) is the real effort here, not the on-chip cryptography — standard PKI hygiene, achievable by leaning on Microchip's provisioning service rather than building an in-house factory keying station from day one.

# 7. Digital Identity Panel (e-ink) & QR behaviour

## 6.1 Panel

- 2.9″, 296×128, 4-greyscale e-ink Module (driver-board version, not the raw panel) — chosen for zero static power draw, so a shelved/unpowered unit still shows its last-known identity to whoever picks it up for the next job.

- Full-refresh only (skips partial refresh entirely, avoiding e-ink ghosting management) — acceptable since content changes are rare. Redraws on boot, on project/config reassignment, on management-IP change, plus a periodic forced refresh (e.g. weekly) purely to clear residual charge buildup.

## 6.2 Content

- Left: Project Name, RackWatch ID, Management port IP, "as of [timestamp]" freshness marker.

- Right: QR code.

- **Live-vs-stale distinction:** since e-ink shows the last-written content even when powered off, the RGB LED (only lit while the unit is actually running) is the signal for "is this current," while the e-ink carries persistent identity.

## 6.3 QR target

Encodes a single canonical cloud URL (id.rackwatch.net/{RackWatch ID}) — never a .local/mDNS address, which fails ungracefully off-network and is unreliable even on-network behind client-isolated AV/broadcast switches. The landing page:

- Public (no login): RackWatch Core {licence tier size}, RackWatch ID, current software version, warranty status, documentation, contact support.

- Behind login (device ID as username; a first-use password issued on the invoice, forcing reset; longer-term tied to a proper customer portal account; time-boxed one-time reset via a verified support ticket): live licence utilisation (e.g. 87/100), recovery image download, support bundle download.

- **"Launch management UI" button:** only renders after a client-side reachability check verifies — by identity, not just "something responded" — that the genuine appliance is live on the current network. Prevents silently connecting to an unrelated device that happens to share a common private IP.

Licence tier size (e.g. "RackWatch Core 100") is public — it's a property of the unit, not the customer's deployment, and is effectively inferable from a published price list anyway. Live utilisation (87/100) is gated, since it reveals real information about a specific customer's deployment size.

# 8. Licensing enforcement & overage handling

- Soft-limit model: exceeding the licensed device count triggers a warning and a grace period (~1 week), bounded by a percentage overage cap — not an immediate hard stop. Monitoring should never silently drop coverage of a device because a limit was hit unnoticed.

- Overage is measured against the current, live device count, not a historical peak — a short-term spike (e.g. a 3-day OB build) that's torn back down afterward shouldn't leave a permanent breach flag.

- **Overage notification:** sustained overage (not a first/momentary breach) queues a store-and-forward report from the appliance — works even if the unit is offline at the moment the breach occurs, since it reports whenever it next reaches the backend. Triggers an automated email to the account/billing contact (not necessarily whoever is on-site) containing only the RackWatch ID and date — deliberately excluding the project name to avoid leaking potentially confidential/embargoed project information from a device that can be physically photographed by anyone nearby. The account contact can follow up with the field engineer directly if more context is needed.

# 9. Software stack — for developer scoping

The domain logic (adapters, state engine, dependency evaluator, incident engine) is already written in TypeScript, and the dashboard prototype is React — these are firm starting points, not open questions. The table below distinguishes what's confirmed from what still needs a decision, so freelance quotes can scope accordingly.

| **Layer** | **Chosen / confirmed** | **Status** |
| --- | --- | --- |
| Domain logic — adapters, state engine, dependency evaluator, incident engine | TypeScript, Node.js runtime | Confirmed — already written |
| Vendor adapter plugin architecture (Section 4) | Formalise the existing Integration/AdapterReference/Observation types into an explicit plugin interface; add SNMP as the baseline adapter | Open — architecture direction set, implementation not yet built |
| Dashboard frontend | React | Confirmed — prototype exists (switch-dashboard.jsx) |
| Local state store | SQLite, WAL mode | Confirmed — chosen for power-loss resilience |
| Device OS | Debian-based Linux (Raspberry Pi OS-derived), read-only root | Confirmed — approach only, distro build TBD |
| Realtime push to dashboard | WebSocket server | Confirmed concept; implementation not yet built |
| Secure-element integration | Microchip CryptoAuthLib (C) — needs a binding layer into the Node/TS runtime | Open — integration approach to be scoped |
| e-ink driver / renderer | Not yet chosen — Waveshare reference libraries are Python/C | Open |
| Cloud backend (id.rackwatch.net, entitlement, PKI records, notifications) | Not yet chosen — TypeScript/Node recommended for one shared skillset with the device app layer | Open — recommendation, not a locked decision |
| PKI / factory provisioning tooling | Microchip Trust Platform Design Suite | Confirmed — factory-side only, not part of the ongoing app stack |

- **Note on the secure-element integration:** CryptoAuthLib is a C library; if the device-side app layer stays Node/TS as planned, this needs an explicit binding approach (native addon, a small companion service, or similar) — worth asking quoting developers to propose their preferred method rather than assuming one, since this is the one place the stack crosses a language boundary.

- **Note on the e-ink driver:** Waveshare's own reference code for this panel is Python/C. Decide whether to call it via a small companion process from the Node/TS app, or reimplement the (well-documented) SPI/refresh sequence natively in TypeScript — worth including as an explicit question in the developer brief rather than assuming either way.

# 10. Open items / next steps

- Resolve the two open stack items above (secure-element binding approach, e-ink driver implementation) — ideally as part of the developer scoping/quoting process itself.

- Confirm concurrent (worker-pool) polling architecture before treating 500 devices as a validated ceiling — see Section 2.1.

- Model RWC500 pricing — currently TBC in the licence table.

- Replace placeholder costs in the hardware cost model with real supplier quotes as they come in (see accompanying spreadsheet).

- Define the operational PKI process — root CA generation/storage, intermediate signing key handling, audit cadence.

- Mechanical/enclosure design, including the modular rear power-plate interchangeability, flexible light-pipe routing, and FPC/cable strain relief for the e-ink and USB3 storage runs.

- Enterprise (>500 devices) commercial conversation structure — intentionally left as a custom quote rather than a published rate, matching how comparable broadcast NMS vendors (Riedel, Evertz) operate at that scale.
