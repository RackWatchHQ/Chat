# 2. Engineering Design Principles

The following principles constrain Build 1 architecture and future development. Where an implementation choice conflicts with a principle, the conflict shall be made explicit and reviewed rather than silently accepted.

## DP-001 — Confidence at a glance

The first visual layer shall answer whether the monitored system is healthy without requiring interpretation of dense telemetry.

Detailed telemetry belongs behind the top-level state, not in place of it.

## DP-002 — Explain, not merely observe

RackWatch shall convert raw observations into meaningful engineering state. A collection of counters, pings and sensor values is not by itself a RackWatch user experience.

Where practical, a fault presentation should help the engineer understand what changed and where investigation should begin.

## DP-003 — Local first

Core monitoring, state evaluation and local presentation shall operate without cloud or Internet connectivity.

External connectivity shall enhance the appliance rather than determine whether it functions.

## DP-004 — Deterministic state

Given the same configuration and the same set of observations, RackWatch shall derive the same operational state.

State changes shall follow defined rules rather than presentation-layer heuristics.

## DP-005 — Vendor-neutral core

Core monitoring and state logic shall not be architecturally coupled to a single equipment manufacturer.

Vendor-specific capability shall be introduced through adapters or equivalent isolated integration components.

## DP-006 — Progressive disclosure

Operational simplicity and engineering depth shall coexist by separating information into layers.

The primary layer shall be concise. Deeper layers may expose diagnostics, telemetry and configuration as required.

## DP-007 — Fail visibly

Unknown, stale, invalid or unavailable monitoring data shall not be silently presented as healthy.

The system shall distinguish a known healthy state from a state it cannot currently determine.

## DP-008 — Supportability is a product feature

The appliance shall expose sufficient identity, version, configuration and diagnostic information to allow a competent engineer or RackWatch support function to understand its condition without requiring undocumented access methods.

## DP-009 — Configuration over customisation

Normal deployment differences should be expressed through controlled configuration rather than site-specific code forks.

The product shall resist architecture that creates a unique software build for each deployment.

## DP-010 — Build the smallest useful system

Build 1 shall implement the capability required to establish a credible, deployable RackWatch product. Features that do not materially support that objective should be deferred rather than increasing first-release complexity.
