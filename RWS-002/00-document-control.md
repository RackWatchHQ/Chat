# RWS-002 — RackWatch Technical Specification

**Revision:** 1.0  
**Status:** Developer Issue  
**Document owner:** RackWatch Engineering  
**Product baseline:** Build 1

---

## Document purpose

RWS-002 defines the technical, physical and implementation constraints for the RackWatch Build 1 appliance. It complements RWS-001, which remains authoritative for product behaviour and engineering architecture.

This document is intended to give prospective development and hardware partners sufficient technical context to assess implementation effort, identify engineering risks and prepare quotations.

## Revision history

| Revision | Status | Description |
|---|---|---|
| 1.0 | Developer Issue | First controlled technical release, consolidated from the current RackWatch technical design work. |

## Technical baseline

The Build 1 product is a rack-mounted, local-first monitoring appliance for broadcast, production and AV infrastructure.

Current baseline assumptions include:

- 1RU RackWatch Core appliance;
- compute architecture based on the Raspberry Pi Compute Module 5 family for the production design, subject to final carrier-board engineering;
- development and early software proving may use standard Raspberry Pi 5 hardware;
- NVMe solid-state storage;
- wired Ethernet as the primary monitored-network interface;
- dual HDMI capability at the compute platform, with the product I/O arrangement defined by the final carrier/chassis design;
- SDI display output provided through an internal HDMI-to-SDI conversion path where required;
- local operation without dependency on Wi-Fi or Internet connectivity;
- hardware-backed product identity/security using a current Microchip CryptoAuthentication device, with final component selection subject to lifecycle verification;
- custom rack chassis and carrier-board design developed together rather than as independent mechanical and PCB exercises.

Items that remain subject to detailed engineering shall be marked **TBD** or **Provisional** rather than guessed.
