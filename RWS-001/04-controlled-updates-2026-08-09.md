# RWS-001 Controlled Updates — 09 August 2026

This file records the current controlled wording introduced into the owner-edited RWS-001 Rev 1.0 Word document and is authoritative for these amended sections until the chapter structure is fully normalised in GitHub.

## 3.2 Reference Hardware

| Component | Build 1 Direction | Status |
|---|---|---|
| Compute | Raspberry Pi Compute Module 5 (CM5) Lite, 4GB RAM, non-wireless | Locked |
| Primary storage | USB3-attached SSD (via M.2 bridge board) | Locked |
| Management network | Dedicated Ethernet interface | Locked |
| Monitoring network A | Assignable Ethernet interface | Locked |
| Monitoring network B | Assignable Ethernet interface | Locked |
| Appliance display | One externally available portrait HDMI output | Locked |
| Broadcast display | Internal landscape HDMI render converted to SDI | Locked |
| Broadcast outputs | Two identical mirrored SDI outputs | Locked |
| Chassis / panel design | 1U productised enclosure | Detailed mechanical design pending |
| Front e-ink display | 2.9-inch e-ink Digital Identity Panel | Locked |

## 4.6 Reference Technology Direction

| Layer | Preferred Direction | Status |
|---|---|---|
| Operating system | Minimal Debian-based ARM64 distribution / Raspberry Pi OS Lite | Reference choice |
| Core services | TypeScript, Node.js | Confirmed — already written |
| Local persistence | SQLite | Preferred |
| Configuration | Versioned YAML with controlled browser editing | Preferred |
| Frontend | TypeScript and React-based local web application | Preferred |
| Live updates | SSE or WebSocket in addition to REST | Developer proposal |
| Service supervision | systemd | Preferred |
| Packaging | Signed package or release bundle | Developer proposal |

## 5.7a Automatic Topology Discovery

A dedicated Topology Discovery Service using LLDP automatically produces relationship graphs across devices. It is structurally distinct from the adapters described in Section 8. Automatically discovered relationships are annotated as **Inferred** and are subject to the same restrictions as any other Inferred dependency.

**SE-011** LLDP-derived topology data shall annotate a device's StateExplanation narrative only and shall never suppress escalation to Critical.

**SE-012** Retraction of a topology-derived relationship shall only remove what the Topology Discovery Service itself created as Inferred, and shall never modify a Configured or Verified dependency.

## 6.5 Appliance Health Identity

The LED-style element within the RackWatch logo communicates health of the RackWatch appliance itself, not the monitored infrastructure.

| Logo LED | Meaning |
|---|---|
| Off | Appliance is shut down. |
| White | Appliance is booting. |
| Green | RackWatch operating normally. |
| Amber | Non-critical internal issue; monitoring remains substantially trustworthy. |
| Red | Critical internal issue that may affect monitoring confidence. |

Where the appliance's own status and the status of monitored infrastructure could suggest different colours, the LED follows a **worst-state-wins** rule: it always reflects the least healthy applicable condition.

The LED transitions in step with the Incident Engine's stability window (Section 7.8) rather than reacting to a single momentary reading.

## Source

Owner-edited controlled Word document: `RWS-001_RackWatch_Engineering_Specification_Rev1_0.docx`, supplied 09 August 2026.
