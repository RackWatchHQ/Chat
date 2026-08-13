# RackWatch SDI

Status: Agreed design specification

RackWatch SDI is the mirrored landscape operational output intended for a production multiviewer or standalone engineering monitor. It inherits the canonical RackWatch state model, colours, symbols and typography from the UI Design System.

## Reference viewing condition

- Two SDI outputs carry the same landscape image.
- The layout is purpose-designed rather than a crop or rotation of RackWatch Display.
- Reference design condition: quarter-screen tile within a 1920 x 1080 multiviewer, approximately 960 x 540 effective viewing area.
- This is a legibility target, not a restriction on larger or smaller presentation.

## Purpose

RackWatch SDI is an exception display, not an inventory or engineering display.

If information does not help an operator determine monitored-system state from a multiview, it does not belong on RackWatch SDI.

## Fixed elements

These remain present and spatially stable across healthy, degraded and fault states:

- RackWatch identity.
- RWC status LED integrated into the RackWatch mark.
- Clock including seconds.

The RWC logo LED represents RackWatch Core appliance health only and is independent of monitored-system state. It is the sole appliance-health indication on SDI. Diagnosis of an RWC issue belongs on RackWatch Display or RackWatch Web.

## Healthy state

When all monitored states required to make the assertion are known and OK, the primary headline is `ALL SYSTEMS HEALTHY` in RackWatch Green.

The healthy information area may also contain the project name and compact group summaries using RackWatch status LEDs. The presentation should remain calm and uncluttered.

## Degraded state

When the monitored system enters DEGRADED:

- Primary headline becomes `DEGRADED` in RackWatch Amber.
- Routine context yields its space to exception information.
- Project name and healthy group summaries may disappear from the information area.
- The affected device or service and observed degraded condition are promoted.

## Fault state

When the monitored system enters FAULT:

- Primary headline becomes `SYSTEM FAULT` in RackWatch Red.
- The red system-fault warning triangle appears.
- Routine context yields its space to fault information.
- Known failed devices/services use RackWatch Red LEDs.
- Dependency-derived UNKNOWN devices use the flat RackWatch Grey chain-link icon in place of their LED.
- Dependency-derived UNKNOWN is not presented as an additional confirmed failure.

## Exception-first priority

During DEGRADED or FAULT conditions, information priority is:

1. Known faults.
2. Degraded conditions.
3. UNKNOWN/dependency context where it explains monitoring state.
4. Routine healthy context only where space remains useful.

Healthy inventory is removed before exception detail is sacrificed. SDI is not intended to show every monitored device.

## Colour and geometry

- Canvas remains the standard RackWatch dark background in every state.
- The whole background never turns green, amber or red.
- Status headline text may use its semantic status colour for immediate recognition at reduced multiview size.
- The red warning triangle remains exclusive to SYSTEM FAULT.
- No equivalent large icon exists for OK, DEGRADED or UNKNOWN.
- LEDs use the agreed subtle illuminated treatment.
- Dependency chains remain flat grey with no glow.
- No status element flashes.

## Clock

The clock includes seconds and remains visible in all states. In addition to showing time, moving seconds provide a simple visual indication that the RackWatch video image is not static or frozen. This is not a substitute for formal output-health monitoring.

## Explicit exclusions

RackWatch SDI has no Engineering section and does not show configuration filename, RWC IP address, RWC location, RWC uptime, appliance telemetry, full device inventory, historical graphs, configuration controls or interactive controls.

## Design principle

The RackWatch SDI frame stays stable while information priority changes. Healthy operation provides confidence at a glance; when RackWatch has an exception to report, routine context yields its pixels to the facts that caused the state change.
