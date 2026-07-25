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

## Pairing (do this once) — no SSH needed

Leave `address` empty, start the add-on, open the Web UI, and click the
**⚙ BT** link on the print bar (or open `./setup.html`). Then:

1. Turn the printer on, keep it close, click **Scan for printers**.
2. Pick the row tagged **SPP** (Serial Port) — NIIMBOT shows two addresses and
   only the SPP one prints — and click **Pair & use**. A NoInputNoOutput agent
   auto-accepts; the MAC is remembered.
3. Go back to the designer and print.

Prefer to pin a specific MAC instead? Set it as `address` in the options (then
the setup page's pairing is disabled). You can still pair over SSH the classic
way (`bluetoothctl` → `power on`, `scan on`, `pair <MAC>`, `trust <MAC>`) if you
like — Home Assistant has no native UI to pair Bluetooth Classic devices.

## REST API (port 5001, also proxied under ingress at `./api/`)

- `POST /print` — `{ "imageBase64": "...", "density": 3, "model": "b21", "quantity": 1, "rotate": 0 }`
- `GET /scan?seconds=8` — list devices `{name,address,spp,likely_printer}` + `current`
- `POST /pair` — `{ "address": "AA:BB:CC:DD:EE:FF" }` pair + remember
- `POST /forget` — drop the remembered printer
- `GET /connected` — `{connected, battery}`
- `GET /setup.html` — the scan/pair Web UI (no SSH)

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
