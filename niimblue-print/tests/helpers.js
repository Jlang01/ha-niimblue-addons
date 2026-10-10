"use strict";
// Shared test helpers. Run the suite with:
//   cd niimblue-print/rootfs/usr/local/lib/niimblue-print && npm install && npm test
const path = require("path");
const fs = require("fs");
const os = require("os");

const LIB = path.resolve(__dirname, "../rootfs/usr/local/lib/niimblue-print");
const lib = (m) => require(path.join(LIB, m));
const sharp = require(path.join(LIB, "node_modules/sharp"));

const tmpDir = (name) => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), `nb-${name}-`));

// The add-on's real geometry: 50x30 mm roll on the B21S -> 384x240 printed,
// 4 px blind zone at feed start/end (gap paper).
const B21S_CANVAS = { width: 384, height: 240, margins: { top: 4, bottom: 4, left: 0, right: 0 } };

module.exports = { LIB, lib, sharp, tmpDir, B21S_CANVAS };
