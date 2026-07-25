# NiimBlue Print (Bluetooth)

Prints NIIMBOT labels over Home Assistant's internal Bluetooth adapter using a
Bluetooth Classic RFCOMM (SPP) socket, coexisting with HA's Bluetooth
integration. See README.md for the overview and serial-vs-Bluetooth comparison.

## Options

| Option | Meaning |
|---|---|
| `address` | Printer Bluetooth MAC. Pair first, then set it here. |
| `model` | `b1` `b18` `b21` `d11` `d110` (B21S → `b21`). |
| `density` | 1–5 print darkness. |
| `rotate` | 0/90/180/270 clockwise rotation before printing. |
| `mqtt_enabled` | Publish connectivity + reconnect entities. |

## Pairing (do this once)

On Home Assistant OS host (or via the SSH add-on):

```
bluetoothctl
  power on
  scan on          # wait for the printer to appear, note its MAC
  pair AA:BB:CC:DD:EE:FF
  trust AA:BB:CC:DD:EE:FF
  quit
```

Then set that MAC as `address`.

## REST API (port 5001, also proxied under ingress at `./api/`)

- `POST /print` — `{ "imageBase64": "...", "density": 3, "model": "b21", "quantity": 1, "rotate": 0 }`
- `GET /scan?seconds=8` — list nearby/known Bluetooth devices `{name,address}`
- `GET /connected` — `{connected, battery}`

## Print from an automation

```yaml
rest_command:
  niimblue_bt_print:
    url: "http://a0d7b954-niimblue-print-bt:5001/print"
    method: POST
    content_type: "application/json"
    payload: >-
      {"imageBase64":"{{ img }}","model":"b21","density":3}
```

Use the add-on's hostname (Info page) as the host. The designer's built-in
**Print** button already posts here through ingress — no YAML needed for
interactive printing.

## Troubleshooting

- **"no 'address' set"** — set the paired printer's MAC in options.
- **Connection refused / timeout** — the printer isn't paired, is asleep, or is
  BLE-only (this backend is Classic SPP). Wake it and re-pair; if it is BLE-only,
  use the serial add-on instead.
- **"image … wide exceeds printhead"** — the label is wider than 384 px (B21);
  shrink it in the designer.
- Check the add-on log: the exact `niimprint` command and its stderr are shown.
