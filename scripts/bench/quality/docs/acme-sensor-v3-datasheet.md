# Acme Sensor (3rd generation) — datasheet

Model code: AS-300. Replaces AS-200 from January 2027.

| Item | Value |
|---|---|
| Detection | Passive infrared + Bluetooth Low Energy 5.3 |
| Range | Up to 30 m in open space, 12 m through one wall |
| Battery | Two AA lithium cells, about 18 months at 20 detections per hour |
| Housing | IP54, white polycarbonate, 62 × 62 × 21 mm, 48 g |
| Operating temperature | 0 °C to 40 °C |
| Mounting | Adhesive pad or screw plate under the desk |
| Certification | KC, CE, FCC |

## Behaviour
- Reports occupancy to the Acme hub every 60 seconds, or at once when the state changes.
- A desk counts as free after 10 minutes without motion.
- Firmware updates arrive over the air through the hub; the sensor keeps working during the update.

## Differences from AS-200
- Battery life up from 12 months to 18 months.
- Range up from 20 m to 30 m.
- Adds through-wall mode for meeting rooms.
