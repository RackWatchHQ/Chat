# 6. Identity & Security

Prompted by a real gap identified mid-design: nothing was stopping a unit being cloned, or a new “appliance” being minted via the recovery USB path.

## 6.1 Three-identity model

**Serial number:** permanent manufacturing identity, internal to RackWatch only, never shown publicly. Recommended to reuse the ATECC608C’s own factory-burned unique serial rather than minting a separate one.

**RackWatch ID (public):** customer-facing identifier, printed on the unit and shown on the e-ink panel, format `RWC-XXXX-XXXX` in Crockford Base32, with an added Crockford check symbol to catch mistyped or mis-heard IDs. This is the identifier licence entitlement, support and device authentication key off. It is explicitly never treated as an authentication secret.

**Private credential:** an asymmetric keypair generated inside a Microchip ATECC608C-TFLXTLS secure element. The private key never leaves the chip and cannot be extracted; only the public key is registered with the RackWatch backend.

## 6.2 Provisioning

Keypair generation and config-zone locking happen once at manufacture via Microchip’s Trust Platform Design Suite / Secure Provisioning Service using a RackWatch-owned root CA. Each chip’s public key is signed by RackWatch at that same factory step, producing a device certificate.

The recovery-USB flow never touches the secure element’s provisioning state; it only restores the OS image.

The intended effect is that SSD/disk cloning cannot produce a second valid appliance and unsigned or uncertified hardware cannot self-register for a valid RackWatch ID.

Key-management discipline — root CA storage, intermediate signing key and audit process — is the principal operational burden. The design intentionally leans on Microchip’s provisioning service rather than requiring an in-house factory keying station from day one.

## Numbering note

This section is intentionally **Section 6** in the current controlled RWS-002 Rev 1.0 document. The previous 6.x/7.x numbering drift has been corrected in the owner-edited Word issue supplied 09 August 2026.
