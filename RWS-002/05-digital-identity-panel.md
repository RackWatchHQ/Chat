# 7. Digital Identity Panel (e-ink) & QR Behaviour

## 7.1 Panel

2.9-inch, 296×128, 4-greyscale e-ink module, using the driver-board version rather than the raw panel. It is chosen for zero static power draw so an unpowered or shelved appliance continues to show its last-known identity.

Full-refresh only. Partial refresh is deliberately avoided to remove ghosting-management complexity. The panel redraws on boot, on project/config reassignment, on management-IP change, and on a periodic forced refresh intended to clear residual charge buildup.

## 7.2 Content

Left side:

- Project Name
- RackWatch ID
- Management port IP
- “as of [timestamp]” freshness marker

Right side:

- QR code

The e-ink panel persists the last-written content while the appliance is unpowered. The RGB LED, which is only active while the unit is running, provides the live-versus-stale distinction.

## 7.3 QR target

The QR code encodes one canonical cloud URL: `id.rackwatch.net/{RackWatch ID}`. It shall not use a `.local` or mDNS address.

Public information, without login:

- RackWatch Core licence tier size
- RackWatch ID
- current software version
- warranty status
- documentation
- contact support

Authenticated information:

- live licence utilisation
- recovery image download
- support bundle download

The “Launch management UI” control should render only after a client-side reachability check verifies by identity, not merely by IP response, that the genuine appliance is live on the current network.

Licence tier size is treated as public product information. Live utilisation is authenticated because it reveals deployment-specific information.

## Numbering note

This section is intentionally **Section 7** in the current controlled RWS-002 Rev 1.0 document. The previous 6.x/7.x heading-numbering drift has been corrected in the owner-edited Word issue supplied 09 August 2026.
