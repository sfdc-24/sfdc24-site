"use strict";

/*
 * Build-side projector for the public WhatsApp feed.
 *
 * The site is public. projectWhatsappStatus is the only emitter for that
 * feed. Its return value replaces whatsapp_status on the public projection.
 * Callers must not copy any other field from the raw record.
 *
 * The emitted object has one field, status, and the value is the string
 * "up" or the string "down". Message text, sender names, phone numbers,
 * guest details, and owner activity times (active, away, last seen, last
 * message) are never read into the result.
 */

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

module.exports = { projectWhatsappStatus };
