"use strict";
/* What to do with a failed print attempt.
 *
 * niimbluelib reports printer-side problems as PrintError(reasonId) with
 * PrinterErrorCode values (from In_PrintError packets or the print status
 * poll). Transport problems are plain Errors (timeouts, "Not connected",
 * BlueZ/noble messages).
 *
 *   classify(err, { started, connected }) -> {
 *     action: "pause"   (printer needs a person: lid, labels, battery, heat;
 *                        the queue waits and retries, the job keeps its place)
 *           | "requeue" (link problem before anything was printed: retry)
 *           | "fail"    (label may be half printed, or a permanent error:
 *                        manual retry only, so no label is printed twice)
 *     state:  short machine-readable reason (lid_open, no_labels, ...)
 *     message: readable text
 *   }
 *
 * `started` = the PageStart packet for some page was sent. After that a retry
 * could print a label twice, so anything but a clean pre-print failure ends
 * the job as failed.
 */

// niimbluelib PrinterErrorCode -> [state, readable, pause?]
const CODES = {
  1: ["lid_open", "the printer lid is open", true],
  2: ["no_labels", "no labels in the printer (or the roll is not seated)", true],
  3: ["battery_low", "the printer battery is too low to print", true],
  4: ["battery_error", "printer battery fault", false],
  5: ["cancelled", "print cancelled on the printer", false],
  6: ["data_error", "the printer rejected the print data", false],
  7: ["overheated", "the print head is too hot, let it cool down", true],
  8: ["no_labels", "the label roll ran out", true],
  9: ["busy", "the printer is busy", true],
  10: ["head_error", "no print head detected", false],
  11: ["too_cold", "the printer is too cold", true],
  12: ["head_loose", "the print head is loose", true],
  13: ["no_ribbon", "no ribbon", true],
  14: ["wrong_ribbon", "wrong ribbon", false],
  15: ["used_ribbon", "ribbon used up", true],
  16: ["wrong_labels", "these labels do not fit this printer", false],
  17: ["paper_type_error", "the printer refused the label type", false],
  18: ["print_mode_error", "the printer refused the print mode", false],
  19: ["density_error", "the printer refused the density", false],
  22: ["comm_error", "printer communication error", false],
  23: ["disconnected", "the printer disconnected", false],
  24: ["canvas_error", "the printer rejected the label size", false],
  28: ["check_paper", "check the label roll", true],
  50: ["illegal_page", "the printer rejected the page", false],
  52: ["receive_timeout", "the printer timed out receiving data", false],
};

const LINK_RE = /not connected|disconnect|timed? ?out|timeout|device not found|connection|le-connection|ECONN|EIO|ENOENT|EPIPE|closed|powered on|no local bluetooth|d-bus|dbus|scan/i;

function classify(err, { started = false } = {}) {
  const message = err && err.message ? err.message : String(err);
  const reason = err && Number.isInteger(err.reasonId) ? err.reasonId : null;
  if (reason !== null && reason > 0) {
    const [state, text, pause] = CODES[reason] || [`printer_error_${reason}`, `printer error ${reason}`, false];
    if (pause && !started) return { action: "pause", state, message: text, code: reason };
    return {
      action: "fail", state, code: reason,
      message: started ? `${text} (during printing: check the label, then retry the job)` : text,
    };
  }
  if (LINK_RE.test(message)) {
    if (!started) return { action: "requeue", state: "unreachable", message };
    return {
      action: "fail", state: "interrupted",
      message: `connection lost during printing (${message}); a label may be half printed. ` +
        "Check the printer, then retry the job",
    };
  }
  return { action: started ? "fail" : "requeue_once", state: "error", message };
}

/** Pre-flight check from the last heartbeat: a reason to wait, or null. */
function heartbeatBlock(hb) {
  if (!hb) return null;
  if (hb.lidClosed === false) return { action: "pause", state: "lid_open", message: CODES[1][1] };
  if (hb.paperInserted === false) return { action: "pause", state: "no_labels", message: CODES[2][1] };
  return null;
}

module.exports = { classify, heartbeatBlock, CODES };
