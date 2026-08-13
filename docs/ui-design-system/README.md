# RackWatch UI Design System

Status: Working specification

This folder is the canonical home for RackWatch operational UI decisions. It is intended to capture agreed behaviour and presentation rules before individual layouts are finalised.

## Core principle

RackWatch reports observed state. It does not determine operational importance.

The interface should remain simple, deterministic and factual. If an engineer must learn an arbitrary visual language to understand RackWatch, the UI is too complicated.

## Operational display surfaces

RackWatch has three distinct UI surfaces. They share the same state model, colour system, symbols and typography, but may use different layouts.

### RackWatch Display — HDMI

- Dedicated local RackWatch operational display.
- Portrait orientation.
- Target resolution: 1080 × 1920.
- Non-interactive.
- Designed for glanceability and viewing at distance.
- Strongest expression of the RackWatch operational visual language.

### RackWatch SDI — 2 × mirrored outputs

- Two SDI outputs carrying the same landscape feed.
- Landscape orientation.
- Intended for integration into a production multiviewer or for use on a standalone engineering monitor.
- Non-interactive.
- Requires a dedicated landscape composition rather than a crop or rotation of the portrait UI.
- Must remain legible when displayed as a multiview tile.

### RackWatch Web

- Responsive, interactive browser interface.
- Layer 1 presents the same operational truth as the local display surfaces.
- Deeper layers provide device, diagnostic, engineering and configuration detail.
- The web UI follows the same design system but is not required to reproduce either fixed video layout.

## Monitoring state model

Canonical monitored states:

- **OK** — device or service is operating normally.
- **DEGRADED** — operating, but a configured check indicates a degraded condition.
- **FAULT** — a configured check has failed.
- **UNKNOWN** — RackWatch is expected to monitor the item but cannot currently establish its state.

`BOOTING` is a temporary presentation of UNKNOWN while RackWatch establishes state. It is not a separate severity.

Items deliberately not monitored do not appear on operational displays and do not contribute to group or system state. They may still exist in configuration.

## Status hierarchy

Operational hierarchy:

`DEVICE → GROUP → SYSTEM`

The highest known state propagates upward. RackWatch does not apply criticality, weighting or subjective operational importance.

A known FAULT at device level makes its group FAULT and the overall system FAULT.

A known DEGRADED state propagates in the same deterministic manner where no FAULT exists.

UNKNOWN is neutral and must not be treated as a confirmed failure.

## Status symbols

### LED circle

The circular LED is the universal RackWatch status indicator and part of the product's visual identity.

- OK — RackWatch Green LED.
- DEGRADED — RackWatch Amber LED.
- FAULT — RackWatch Red LED.
- UNKNOWN — RackWatch Grey LED.
- LED treatment is subtle and illuminated, with restrained depth/glow.
- LEDs remain static once state is established; no flashing status LEDs.

The LED shape does not vary by device type or fault type.

### Dependency chain

A flat grey chain-link icon is reserved exclusively for dependency-derived UNKNOWN state.

If RackWatch cannot determine the state of a device because a defined upstream dependency is unavailable, the normal status LED is replaced by the grey chain-link icon.

Rules:

- The chain is always grey.
- The chain is flat, with no LED-style glow.
- No green, amber or red chain variants exist.
- The chain replaces the LED rather than appearing alongside it.
- It communicates "state unknown because of dependency".
- Dependency-derived UNKNOWN does not create an additional fault.
- When the dependency recovers, the chain remains until the dependent device's own state has been re-established.
- The chain-link symbol must not be reused as a generic navigation, hyperlink or relationship icon in the operational UI.

### Fault warning triangle

The red warning triangle is reserved for overall SYSTEM FAULT state.

- It appears once at the highest level of the operational display.
- It does not appear beside individual devices or groups.
- It means RackWatch has directly detected at least one FAULT somewhere in the monitored system.
- It does not imply criticality, urgency or production impact.
- No equivalent large symbol exists for OK, DEGRADED or UNKNOWN.
- The triangle derives its value from being exceptional and visually interruptive.

## Colour system

Status colours are semantic and reserved.

| Token | Hex | Meaning |
|---|---|---|
| RackWatch Green | `#2ED47A` | OK and primary RackWatch brand green |
| RackWatch Amber | `#F2B84B` | DEGRADED |
| RackWatch Red | `#E5484D` | FAULT |
| RackWatch Grey | `#7A8288` | UNKNOWN and dependency chain |

RackWatch Green is both the product green and the system OK green. The eventual logo and brand artwork should inherit this colour rather than define a separate green.

Status colours are not decorative UI accents. In the operational interface:

- Green means OK.
- Amber means DEGRADED.
- Red means FAULT.
- Grey means UNKNOWN or neutral state where explicitly defined.

Buttons, links, tabs and decorative accents should not use status colours simply for branding or emphasis.

### Neutral palette

Current agreed foundation:

| Token | Hex |
|---|---|
| Canvas | `#0B0D0E` |
| Primary panel | `#121517` |
| Raised panel | `#181C1F` |
| Divider / border | `#292E32` |
| Primary text | `#E8EAEB` |
| Secondary text | `#9BA1A5` |
| Tertiary / engineering text | `#686F74` |

The operational UI is dark-only. This is an operational requirement for continuous use in broadcast, production and AV environments with controlled or low task lighting, not an optional theme.

Avoid pure black backgrounds, large blocks of status colour, and blue/cyan-biased "cybersecurity dashboard" styling.

## Typography

Inter is the sole RackWatch operational UI typeface.

No secondary display or monospace font is required.

Hierarchy is created through:

1. Size — importance and intended viewing distance.
2. Weight — structural hierarchy.
3. Luminance — primary, secondary and tertiary information.

Mixed case is the default for readability. ALL CAPS is reserved for short status terms such as `FAULT` where additional emphasis is useful.

Status colours must not be used merely to create typographic hierarchy.

## General presentation principles

- Calm in normal operation.
- Colour belongs primarily to status information.
- OK should not shout.
- DEGRADED should be noticeable but restrained.
- FAULT introduces the major visual interruption through the system-level warning triangle.
- UNKNOWN is neutral rather than alarming.
- No flashing indicators.
- Avoid unnecessary icons; every symbol must have one clear operational meaning.
- Configuration inventory is not operational status. If an item is deliberately not monitored, it is absent from the operational UI.

## Next design work

The next workstream is to define information hierarchy and layout separately for:

1. Portrait HDMI RackWatch Display.
2. Landscape mirrored SDI output.
3. Web Layer 1 and deeper interactive layers.

Exact component sizing, spacing, grid rules, text sizes, device/group card anatomy and responsive behaviour remain to be defined.