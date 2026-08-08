# 2. Monitoring and Adapter Architecture

## 2.1 Vendor-neutral requirement

RackWatch shall operate across mixed-vendor broadcast and AV networks without assuming that a single manufacturer's API is available.

## 2.2 Layered evidence model

The permanent monitoring baseline for every supported device shall be **SNMP and ICMP**.

These baseline sources shall continue operating when a richer vendor-specific adapter is available. A vendor API adapter sits on top of the baseline as an additional evidence source rather than replacing it.

This architecture preserves independent corroboration between monitoring sources and supports the State Engine confidence model defined in RWS-001.

SNMP also provides a discovery/fingerprinting role. Standard fields including `sysDescr` and `sysObjectID` may be used to identify vendor and model and determine whether a richer adapter is available.

## 2.3 Vendor-specific adapters

Vendor adapters extend RackWatch's understanding of a device while preserving the vendor-neutral core.

The existing domain concepts `Integration`, `AdapterReference` and `Observation` shall form the basis of a formal plugin contract.

The external development scope shall include formalising how a vendor adapter is built, versioned, loaded, verified and executed.

## 2.4 Downloadable adapter library

The product direction includes a RackWatch-managed library of vendor-specific adapters.

Where Internet/backend access is available, an appliance may:

1. identify a device vendor/model using SNMP fingerprinting;
2. determine whether a compatible adapter is already installed;
3. query the RackWatch backend for a compatible adapter;
4. download and install that adapter when entitled and available.

The architecture is intended to allow an appliance to gain richer vendor coverage over its service life without a hardware change or full firmware reflash.

## 2.5 Adapter package security

Downloaded adapter packages shall be code-signed by RackWatch.

The appliance shall execute only adapter packages whose provenance and integrity can be verified against the RackWatch trust infrastructure.

This is a security boundary: adapters may handle SNMP community strings, vendor API credentials and access to customer network devices. The update channel shall therefore not permit arbitrary or unverified code execution.

The adapter-signing model should reuse the product trust infrastructure established for device identity rather than creating an unrelated trust mechanism.

## 2.6 Commercial relevance

The growing adapter library provides continuing product value beyond firmware and security maintenance. Access to new or improved vendor integrations may therefore form part of the ongoing licence/support value proposition.
