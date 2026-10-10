# NiimBlue Print (Bluetooth) — DEPRECATED

> **Deprecated.** Use the **NiimBlue Print** add-on with `transport: ble`
> instead. It prints over Bluetooth LE through Home Assistant's own adapter
> (BlueZ via D-Bus, coexists with HA Bluetooth) using the same protocol library
> as USB, and is verified on a B21S. This add-on's niimprint backend prints
> blank labels on the B21S. Kept only so existing installs see this notice.

Same NiimBlue label designer in the Home Assistant sidebar as the serial
add-on, but printing goes over the **host's internal Bluetooth adapter**.

The backend ([`niimprint`](https://github.com/AndBondStyle/niimprint)) connects
with a **Bluetooth Classic RFCOMM (SPP) socket** (`AF_BLUETOOTH`). That socket
is arbitrated by the kernel/BlueZ — the same stack Home Assistant's Bluetooth
integration uses — so it **shares the adapter with HA** instead of seizing it.
No raw HCI user-channel (noble), so HA Bluetooth keeps working. No USB
Bluetooth dongle, no USB serial passthrough.

> **Classic, not BLE.** This uses Bluetooth Classic (SPP), which is what
> niimprint speaks. Your printer must support Classic SPP and be paired. If the
> B21S turns out to be BLE-only, this backend won't connect — use the serial
> add-on, or open an issue for a BLE (bleak) backend.

## When to use which add-on

| | NiimBlue Print (serial) | NiimBlue Print (Bluetooth) |
|---|---|---|
| Transport | USB-serial (`/dev/ttyACM*`) | Bluetooth Classic RFCOMM |
| Needs | USB passthrough to the VM | paired printer + HA Bluetooth adapter |
| HA Bluetooth | untouched | shared (coexists) |
| Reliability / speed | high | lower |
| Battery / live info | yes (MQTT) | no (connect-on-demand) |

**Recommendation:** if USB serial works for you, keep the serial add-on — it is
faster and more reliable. Use this variant when you cannot pass the USB device
through and want to print over HA's built-in Bluetooth.

## Setup

1. **Pair the printer** with the host adapter first (turn the printer on, then
   on HA OS: `bluetoothctl` → `scan on` → `pair <MAC>` → `trust <MAC>`), or use
   this add-on's `…/api/scan` to find the MAC after a scan.
2. Install the add-on, open **Configuration**, set `address` to the printer's
   MAC and `model` (B21S → `b21`), `density`, `rotate`.
3. Start. Design a label in the sidebar and click **Print** — the image is sent
   to the printer over Bluetooth.

## How it coexists with HA Bluetooth

RFCOMM/SPP connections are managed by the kernel Bluetooth stack + BlueZ, which
multiplex the adapter across clients. The add-on needs `host_dbus: true` (to
pair/scan via BlueZ) and `NET_RAW`/`NET_ADMIN` (to open the `AF_BLUETOOTH`
socket). It does **not** take the adapter down or claim it exclusively, so HA's
Bluetooth sensors keep running on the same radio.

## Status

Experimental. Architecture complete; **not yet verified against a physical
printer** or confirmed that the B21S accepts Classic SPP. If a print fails,
check the add-on log — the `niimprint` command and its error are logged.
