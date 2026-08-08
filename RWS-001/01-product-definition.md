# 1. Product Definition

## 1.1 Product purpose

RackWatch is a lightweight monitoring appliance for broadcast, production and AV infrastructure. It is intended to give engineers rapid confidence in the operational state of an installation without attempting to replace a general-purpose enterprise network-management platform.

The product shall prioritise **confidence at a glance**. The primary presentation layer shall make the current condition of the monitored system immediately understandable; deeper engineering information shall remain available through deliberate drill-down rather than being forced onto the primary display.

## 1.2 Build 1 objective

Build 1 shall provide a deployable appliance capable of monitoring a defined set of IP-connected infrastructure, evaluating observations into deterministic states and presenting those states locally and through a browser interface.

The initial product is intended for broadcast and production environments where engineers need a simple answer to a simple operational question: **is the infrastructure healthy, and if not, where should I look?**

## 1.3 Product boundary

RackWatch shall monitor infrastructure; it shall not become the infrastructure control plane.

Build 1 shall therefore favour observation, interpretation and presentation over device configuration or remote control. Device-specific integrations may expose richer monitoring information where useful, but the core product architecture shall remain vendor-neutral.

## 1.4 Build 1 capabilities

Build 1 shall support, at minimum:

- configurable monitored devices and logical groups;
- IP reachability monitoring;
- SNMP-derived monitoring where supported by the target device;
- an extensible adapter model for richer vendor or protocol integrations;
- deterministic device, group and system state evaluation;
- incident identification and recovery handling;
- local appliance display output;
- browser-based engineering access;
- persistent configuration;
- engineering logging and diagnostics;
- appliance identity and support information.

## 1.5 Explicit non-goals

Build 1 is not intended to be:

- an enterprise IT monitoring suite;
- a replacement for SolarWinds, PRTG or equivalent NMS platforms;
- a network configuration-management system;
- a broadcast control system;
- a general automation platform;
- dependent on Internet or cloud connectivity for normal site operation.

These boundaries are intentional. Additional capability shall not be accepted merely because the underlying platform makes it technically possible.

## 1.6 Deployment philosophy

The appliance shall remain useful on isolated production networks. Normal monitoring, state evaluation and local presentation shall continue without Internet access.

Cloud-connected services may be introduced in later product phases, but Build 1 behaviour shall not assume their availability.

## 1.7 User model

RackWatch is primarily an engineering tool. The interface shall therefore expose useful technical depth without allowing that depth to compromise the clarity of the top-level operational view.

The product should support progressively deeper information layers. Access to deeper configuration or administrative functions may be constrained by user privilege, while the top-level health view should remain deliberately simple.
