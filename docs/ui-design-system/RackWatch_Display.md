# RackWatch Display

Status: Working specification

The RackWatch Display is the dedicated portrait HDMI operational output. Its purpose is to provide confidence at a glance from several metres away while exposing enough detail to direct an engineer toward the relevant issue.

## Healthy-state language

The normal healthy-state headline is:

`ALL SYSTEMS HEALTHY`

This wording is intentionally slightly more human than `SYSTEM OK`, while remaining factual. It may be shown only when every monitored state required to make that assertion is known and healthy.

If monitored state is UNKNOWN, RackWatch must not claim that all systems are healthy.

## RackWatch Core appliance LED

The LED integrated into the RackWatch logo reports the health of the RackWatch Core appliance itself, not the health of the monitored infrastructure.

- Green — RWC healthy.
- Amber — RWC degraded.
- Red — RWC fault.
- Grey — RWC health not yet established.

RWC health and monitored-system health are independent truths. The Display may legitimately show a red or amber RWC logo LED while the monitored system remains healthy.

An RWC fault does not automatically change monitored-system state.

## Group presentation

Groups are shown as single-column sections in the portrait layout.

The RackWatch Display is exception-first rather than inventory-first.

### Healthy groups

When a group is entirely healthy, it is collapsed by default and shown as a group header only.

A chevron remains visible to communicate that the group is collapsed and contains further device detail. On RackWatch Display the chevron communicates presentation state, not user interactivity.

### Degraded or faulty groups

If a group contains DEGRADED, FAULT, UNKNOWN or dependency-derived UNKNOWN states, the group expands automatically.

Within an expanded group, exception states are promoted to the top in this order:

1. FAULT
2. DEGRADED
3. UNKNOWN / dependency-derived UNKNOWN
4. OK

The configured inventory order is not permanently changed. This is a presentation sort while an exception exists.

Healthy devices may remain visible beneath exceptions where space allows. If available screen space becomes constrained, healthy device detail is sacrificed before exception detail.

A compact summary such as `18 other devices healthy` may replace healthy rows when required.

When the group returns fully to OK, it collapses again automatically.

Guiding principle:

> RackWatch Display expands exceptions, not inventory.

## Dependency presentation within groups

If a master or upstream device fails and dependent devices can no longer be checked, the master shows its directly observed FAULT state using the red LED.

Each dependent device whose state can no longer be established replaces its normal LED with the flat grey dependency-chain icon.

Dependent devices are UNKNOWN. They are not shown as red merely because the upstream dependency has failed.

Once the dependency recovers, the chain remains until each dependent device's own state has been re-established.

## Fault presentation

When the overall monitored system enters FAULT:

- The system-level red warning triangle appears.
- The affected group or groups expand automatically.
- The faulting device or devices move to the top of their group.
- Dependency-unknown devices are shown beneath direct faults using grey chain icons.
- The UI must not describe the event as `CRITICAL` or make claims about production impact.

Recommended system-level wording is factual, for example:

`SYSTEM FAULT`

with the directly observed cause beneath where appropriate.

## Degraded presentation

A DEGRADED system does not gain an additional warning symbol.

Amber state treatment is sufficient. The red warning triangle remains exclusive to SYSTEM FAULT so that its visual meaning is not diluted.

## Engineering area

The Engineering area is deliberately quiet in healthy operation and follows the same exception-first philosophy as the rest of RackWatch Display.

### Healthy RWC

Show only information that helps identify and access the appliance:

- Configuration currently loaded.
- Location.
- RWC IP address.

Uptime is not required on RackWatch Display in normal operation and belongs in the web engineering/detail view.

Version, temperature and similar engineering values should not be permanently displayed merely because they exist.

### RWC degraded or fault state

When RWC health is not OK, routine appliance information yields to exception information.

The configuration line may be replaced by the highest-priority RWC exception, for example:

`RWC TEMPERATURE HIGH — 82°C`

Location and IP address remain visible because they are useful for physical identification and troubleshooting access.

The RWC logo LED communicates severity; the Engineering area communicates cause. No additional warning icon is required in the Engineering area.

This allows RackWatch Display to communicate two independent facts simultaneously, for example:

- RWC appliance: FAULT.
- Monitored system: ALL SYSTEMS HEALTHY.

## Layout principles

Current agreed structure:

1. RackWatch header and RWC status LED.
2. Overall monitored-system state and project context.
3. Vertically stacked monitored groups.
4. Automatically expanded exception detail where required.
5. Quiet Engineering area at the bottom.
6. Thin overall-state line at the bottom edge.

The Display should not use decorative graphs, gauges, network maps or large percentage-health metrics when direct device/group state communicates the operational truth more efficiently.

## Remaining work

The behavioural model is substantially defined. Remaining work includes exact component sizing, spacing, typography sizes, chevron treatment and final visual mock-ups for healthy, degraded, monitored-system fault and RWC fault states.