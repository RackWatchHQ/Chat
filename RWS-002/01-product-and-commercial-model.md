# 1. Product and Commercial Model

## 1.1 Product definition

RackWatch Core is a physical monitoring appliance for network switches and broadcast/AV infrastructure, targeted at professional AV and broadcast deployments including OB trucks, flypacks and fixed facility racks rather than general IT.

The product is deliberately vendor-agnostic. Real-world deployments may mix Netgear, Juniper, Arista, Cisco and other switch vendors within the same truck or facility, so the monitoring layer shall not assume that any single manufacturer's API is present.

The technical design follows a repeated product principle: minimise bespoke parts, maximise field-serviceability, and keep service-replacement items sourceable from mainstream electronics or broadcast distribution wherever practical.

## 1.2 Commercial architecture

Hardware is sold separately from the software licence as a one-time capital purchase rather than being amortised into the subscription term.

Licence capacity is a software entitlement bound to the RackWatch hardware identity. The same hardware SKU is intended to support all standard licence tiers.

## 1.3 Licence tiers

The working commercial model uses block-based device-count licensing. Customers buy the tier covering their required device count and round up to the next block.

| Tier | Devices | Indicative annual price | Indicative £/device/year |
|---|---:|---:|---:|
| RWC25 | 25 | £800–£1,000 | £32–£40 |
| RWC50 | 50 | £1,400–£1,700 | £28–£34 |
| RWC150 | 150 | £3,200–£3,800 | £21–£25 |
| RWC200 | 200 | £3,800–£4,500 | £19–£22 |
| RWC250 | 250 | £4,300–£5,000 | £17–£20 |
| RWC500 | 500 | TBC | TBC |
| Enterprise | 500+ | Custom quote | ~£14–£17 |

The source design raises the maximum standard tier from 250 to 500 devices on the basis that CPU, RAM, storage and network bandwidth are expected to have sufficient headroom without a BOM change.

### Technical dependency

A 500-device ceiling depends on concurrent polling. Device polling shall therefore use a worker-pool or equivalent concurrent architecture rather than a purely sequential one-at-a-time loop.

This is a developer-scoping requirement and shall not be treated as a later optimisation.

## 1.4 Hardware pricing assumptions

Working commercial assumptions from the source design are:

- integrator trade price: approximately £1,400–£1,600;
- low-volume landed build-cost assumption used for that model: approximately £1,000;
- suggested resale/MSRP: approximately £2,000–£2,400;
- selective hardware discounting or inclusion may be considered against a three-year licence commitment for larger deals rather than as the default commercial model.

These figures remain commercial assumptions rather than verified manufacturing quotes.

## 1.5 Single hardware SKU

The product direction is one carrier board and one BOM across all licence tiers.

Device capacity, monitoring-NIC segment count and power-redundancy options are configuration, entitlement or build-time choices rather than separate compute variants.

The carrier design uses four physical 2.5GbE monitoring ports, with two active by default as Monitoring A and Monitoring B and all four software-assignable. Unlocking all four as independent monitoring segments remains a candidate paid entitlement.

Power redundancy is decoupled from licence tier through a modular rear power arrangement allowing either dual-AC or AC+DC build-time fitment.

Licence upgrades are intended to be backend entitlement changes bound to the RackWatch ID, without requiring a truck roll or firmware reflash.
