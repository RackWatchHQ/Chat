# 3. System Architecture

## 3.1 Logical model

RackWatch shall separate **observation**, **interpretation** and **presentation**.

At a high level:

```text
Monitored Device
      ↓
Monitoring Source / Adapter
      ↓
Normalised Observation
      ↓
State Engine
      ↓
Incident / Correlation Logic
      ↓
Device + Group + System State
      ↓
Presentation Layers / Diagnostics
```

This separation is fundamental. Presentation components shall consume evaluated state rather than independently deciding whether equipment is healthy.

## 3.2 Monitoring sources

A monitoring source obtains evidence about a target. Sources may include ICMP reachability, SNMP, local appliance telemetry or richer device-specific integrations.

Monitoring sources shall normalise their results into a form that the state engine can evaluate without requiring the state engine to understand every vendor protocol.

## 3.3 Adapter framework

The adapter framework shall provide a controlled boundary between RackWatch core behaviour and equipment-specific integrations.

An adapter may:

- discover or poll supported telemetry;
- transform protocol-specific values into normalised observations;
- expose adapter health and data freshness;
- provide human-readable diagnostic context.

An adapter shall not independently redefine global RackWatch state semantics.

ICMP and SNMP shall be treated as baseline monitoring mechanisms rather than as vendor-specific product integrations.

## 3.4 State engine

The State Engine is the authoritative evaluator of operational condition.

It shall derive device state from current observations and configured rules, and shall derive group and system state from the evaluated state of their constituent objects.

The UI shall not override or reinterpret State Engine results.

## 3.5 Incident handling

A state transition that represents an operational fault shall be capable of creating or updating an incident record. Recovery shall be represented explicitly rather than erasing evidence that a fault occurred.

The incident model shall distinguish current condition from event history.

## 3.6 Configuration

Configuration shall define monitored objects, grouping, monitoring methods and relevant evaluation parameters.

Build 1 shall use a human-readable configuration representation suitable for controlled engineering deployment. YAML is the baseline configuration format.

Configuration shall be validated before becoming active. An invalid candidate configuration shall not silently replace a previously valid running configuration.

## 3.7 Presentation

Build 1 shall support local display and browser presentation from the same underlying state model.

The local portrait display is intended primarily as an at-a-glance operational surface. The browser interface may expose deeper engineering information and configuration according to privilege.

## 3.8 Appliance boundary

RackWatch Core shall be treated as an appliance, not as a general-purpose user workstation.

Implementation choices should minimise the need for local shell access during normal operation and support. Required engineering diagnostics should be deliberately exposed through supported mechanisms.
