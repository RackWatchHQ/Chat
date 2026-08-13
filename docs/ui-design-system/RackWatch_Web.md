# RackWatch Web

Status: Agreed design specification

RackWatch Web is the responsive, interactive operational interface. It inherits the canonical RackWatch state model, colours, symbols, typography and factual reporting principles from the RackWatch UI Design System.

## Core principle

Complexity is available, not imposed.

Operational hierarchy:

`Layer 1 — System -> Layer 2 — Group -> Layer 3 — Device`

Configuration and administration are separate tasks, not a fourth monitoring layer.

## Persistent sidebar

The left-hand rail remains persistent and contains RackWatch identity, the independent RWC health LED, clock with seconds, Site Overview, group navigation, Engineering information, and minimal user/settings controls.

The Engineering area remains visible on Web and may show loaded configuration, RWC IP address, location, uptime and RWC temperature. It stays visually subordinate. If the RWC develops an issue, the relevant appliance exception is promoted there.

## Layer 1 — System

Purpose: answer whether the monitored system is healthy and, if not, where the exception is.

Healthy state:
- `ALL SYSTEMS HEALTHY`.
- Project/site context.
- Group cards.
- No synthetic hero metrics or percentage-health scores.

Degraded state:
- `DEGRADED` in RackWatch Amber.
- Exception area directly beneath overall status.
- Affected device/service and observed condition shown factually.
- Group overview remains available below.

Fault state:
- `SYSTEM FAULT` in RackWatch Red.
- Red system-fault warning triangle at overall system level only.
- Known failed devices/services use Red LEDs.
- Dependency-derived UNKNOWN devices use the flat Grey chain-link icon.
- Group overview remains available below.

Unknown-only state:
- RackWatch must not show `ALL SYSTEMS HEALTHY` if monitored state cannot be fully established.
- Use a neutral incomplete-status treatment with no warning triangle. Final wording remains open.

### Layer 1 group cards

Healthy cards show only:
- Group status LED.
- Group name.
- Device count.
- Whole card is clickable into Layer 2.

When exceptions exist, cards may add concise counts such as `6 devices · 1 fault · 2 unknown`.

Cards do not duplicate device names or full exception descriptions. Group UNKNOWN uses the standard Grey LED; the dependency chain remains reserved for device-level dependency-derived UNKNOWN.

## Layer 2 — Group

Purpose: show the complete monitored inventory for a selected group.

Default order:
1. FAULT.
2. DEGRADED.
3. UNKNOWN.
4. OK.

The user may change sort order. Search should be available for larger groups without dominating the layout.

Each device row/card contains:
- Status LED, or Grey dependency chain where applicable.
- Device name.
- Primary IP/address where relevant.
- Navigation into Layer 3.

Exception rows may use one secondary factual line such as `No response to ICMP check` or `State unknown — dependency Core Switch unavailable`.

Breadcrumbs should make the hierarchy explicit, e.g. `Site Overview / Switches / Core Switch`.

## Layer 3 — Device

Purpose: show what RackWatch knows about a selected device and why RackWatch has assigned its current state.

### Identity and current state

Show device name, current RackWatch state and primary IP/address where relevant.

### Recent Health

A compact recent-health bar/timeline appears near the top of the page.

- Green = OK.
- Amber = DEGRADED.
- Red = FAULT.
- Grey = UNKNOWN.
- Dependency-derived UNKNOWN is Grey in the bar; chain icons are not repeated inside it.
- No synthetic health score or percentage.
- It is a state history, not an analytics graph.

Hovering an abnormal segment may show timestamp, state and relevant evidence/check where available. The default time window remains to be defined.

### Evidence and configured checks

Layer 3 shows what RackWatch is actually checking.

Healthy checks may remain concise. When a device is DEGRADED or FAULT, relevant evidence is promoted before routine metadata.

Evidence may include observed value/condition, configured threshold, last-check timestamp and monitoring source/protocol where useful.

RackWatch reports measured facts and configured rules rather than interpreting production impact.

### Device Information

Where known, show useful factual metadata such as:
- IP address.
- MAC address.
- Hostname.
- Manufacturer.
- Model.
- Serial number.
- Firmware.
- Other device-specific known facts.

Do not force every device into a rigid schema full of `N/A` values.

Device Information is what RackWatch knows about the device. Monitoring is what RackWatch is actively checking.

### Dependencies

Where dependency relationships exist, Layer 3 may show what the device depends on and what depends on it. These relationships should be navigable where useful.

## Interaction model

- Layer 1 group card -> Layer 2 group.
- Layer 1 exception -> affected Layer 3 device where appropriate.
- Layer 2 device -> Layer 3 device.
- Avoid modal navigation rabbit holes unless a specific workflow requires them.

## Explicit exclusions from the core operational UI

No criticality classifications, subjective incident severity, confidence scores, correlation scores, inferred production impact, large blocks of status colour, or decorative charts without a clear operational purpose.

## Design progression

Layer 1 is clean and glanceable.
Layer 2 is technical and inventory-focused.
Layer 3 is the engineering evidence layer.

Complexity is available, not imposed.
