# 3. Field Serviceability

## 3.1 Design intent

The guiding serviceability constraint is that an OB engineer should be able to keep a RackWatch Core operational using locally sourced replacement parts wherever genuinely practical.

The carrier board is expected to remain the principal RackWatch-specific service component.

## 3.2 Service-source classification

| Component | Expected source | Category |
|---|---|---|
| Carrier board | RackWatch | Bespoke |
| CM5 compute module | Raspberry Pi / electronics distributors | Specialist retail |
| 4-port 2.5GbE interface hardware | Electronics distributors | Specialist retail |
| Storage bridge / NVMe SSD | Computer/electronics retailer | Commodity |
| PSU module | Industrial/electronics supplier | Commodity |
| Ideal-diode ORing module | Embedded/electronics supplier | Commodity |
| PWM fans | PC/electronics retailer | Commodity |
| HDMI-to-SDI converter | AV/broadcast dealer | Specialist retail |
| E-ink module | Electronics distributor | Commodity / specialist |
| RGB LED / light pipe | Electronics distributor | Commodity / specialist |
| Secure element | Microchip / authorised distributor | Specialist retail |

Final component selection and service procedures remain subject to detailed hardware engineering.

## 3.3 Replacement philosophy

Replaceable commodity components should not require a RackWatch-specific equivalent where an industry-standard part can satisfy the electrical, mechanical and reliability requirements.

Service procedures shall distinguish components that may be safely field-replaced from components whose replacement affects device identity, provisioning, certification or warranty.

## 3.4 Recovery philosophy

Software and storage recovery shall be designed around a branded recovery mechanism rather than routine shell administration.

A failed serviceable SSD should be replaceable without requiring replacement of the complete appliance. Identity and licence entitlement shall not depend solely on data stored on the replaceable SSD.
