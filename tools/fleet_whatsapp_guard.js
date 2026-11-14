"use strict";

/*
 * Build-side projector for the public WhatsApp feed.
 *
 * The site is public. projectWhatsappStatus is the only emitter for that
 * feed. publishFleetPublic copies the public fleet fields and replaces
 * whatsapp_status with that result before any snapshot is serialized.
 *
 *   node tools/fleet_whatsapp_guard.js --in raw.json --out fleet-public.json
 *
 * The emitted WhatsApp object has one field, status, and the value is the
 * string "up" or the string "down". Message text, sender names, phone
 * numbers, guest details, and owner activity times (active, away, last
 * seen, last message) are never read into the result.
 */

var fs = require("fs");

var PUBLIC_KEYS = [
  "schema",
  "public_status",
  "transport",
  "poll_seconds",
  "read_at",
  "fresh_within_sec",
  "sse_path",
  "agents",
  "conference_status"
];

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function unwrap(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && hasOwn(raw, "whatsapp_status")) {
    return raw.whatsapp_status;
  }
  return raw;
}

function isUp(raw) {
  if (raw === "up") return true;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  var status = hasOwn(raw, "status") ? raw.status : undefined;
  var up = hasOwn(raw, "up") ? raw.up : undefined;
  var statusKnown = status === "up" || status === "down";
  var upKnown = up === true || up === false;
  if (hasOwn(raw, "status") && !statusKnown) return false;
  if (hasOwn(raw, "up") && !upKnown) return false;
  if (!statusKnown && !upKnown) return false;
  if (status === "up" && up === false) return false;
  if (status === "down" && up === true) return false;
  return status === "up" || up === true;
}

function projectWhatsappStatus(raw) {
  return { status: isUp(unwrap(raw)) ? "up" : "down" };
}

function publishFleetPublic(raw) {
  var source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  var out = {};
  PUBLIC_KEYS.forEach(function (key) {
    if (hasOwn(source, key)) out[key] = source[key];
  });
  out.whatsapp_status = projectWhatsappStatus(raw);
  return out;
}

function parseArgs(argv) {
  var input = "";
  var output = "";
  for (var i = 2; i < argv.length; i++) {
    if (argv[i] === "--in") input = argv[++i] || "";
    else if (argv[i] === "--out") output = argv[++i] || "";
    else throw new Error("bad args");
  }
  if (!input || !output) throw new Error("bad args");
  return { input: input, output: output };
}

function writeFleetPublic(inputPath, outputPath) {
  var raw = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  var doc = publishFleetPublic(raw);
  fs.writeFileSync(outputPath, JSON.stringify(doc, null, 2) + "\n");
  return doc;
}

if (require.main === module) {
  try {
    var args = parseArgs(process.argv);
    writeFleetPublic(args.input, args.output);
  } catch (err) {
    process.stderr.write("fleet public snapshot was not written\n");
    process.exit(1);
  }
}

module.exports = {
  projectWhatsappStatus: projectWhatsappStatus,
  publishFleetPublic: publishFleetPublic,
  writeFleetPublic: writeFleetPublic
};
