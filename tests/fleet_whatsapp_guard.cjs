const { test } = require("node:test");
const assert = require("node:assert/strict");
const { projectWhatsappStatus } = require("../tools/fleet_whatsapp_guard.js");

const MESSAGE = "Diagram is up for review. Meet me in the lobby in five minutes.";
const OWNER = "Abdus Salam";
const GUEST = "Priya Nair";
const ACTIVE_AT = "2026-11-07T00:59:10Z";
const AWAY_SINCE = "2026-11-06T18:04:00Z";
const LAST_SEEN = "2026-11-07T00:58:00Z";
const LAST_MESSAGE = "2026-11-07T00:57:30Z";

const PHONES = [
  "416-555-0199",
  "416.555.0199",
  "416 555 0199",
  "(416) 555-0199",
  "4165550199",
  "+1 416 555 0199",
  "+14165550199",
  "+1 (416) 555-0199",
  "1-416-555-0199",
  "+44 20 7946 0958",
  "+44 7700 900123",
  "whatsapp:+1-416-555-0199"
];

function hostile(extra) {
  return Object.assign({
    source: "whatsapp",
    text: MESSAGE,
    body: MESSAGE,
    message: MESSAGE,
    caption: "Guest " + GUEST + " wrote: " + MESSAGE,
    sender: OWNER,
    from: OWNER,
    author: "Mr. Salam",
    guest: GUEST,
    guest_name: "Jordan Lee",
    phone: PHONES[0],
    phones: PHONES,
    at: ACTIVE_AT,
    active: true,
    active_at: ACTIVE_AT,
    away: true,
    away_since: AWAY_SINCE,
    presence: "away",
    last_seen: LAST_SEEN,
    lastSeen: LAST_SEEN,
    last_message_at: LAST_MESSAGE,
    last_message: MESSAGE
  }, extra || {});
}

function assertOnlyStatus(raw, expected) {
  const out = projectWhatsappStatus(raw);
  assert.notEqual(out, raw);
  assert.deepEqual(Object.getOwnPropertyNames(out), ["status"]);
  assert.deepEqual(Object.keys(out), ["status"]);
  assert.equal(out.status, expected);
  assert.equal(JSON.stringify(out), '{"status":"' + expected + '"}');
  const encoded = JSON.stringify(out);
  const banned = [MESSAGE, OWNER, "Salam", "Mr. Salam", GUEST, "Jordan Lee", ACTIVE_AT, AWAY_SINCE, LAST_SEEN, LAST_MESSAGE, "away", "lobby"].concat(PHONES);
  for (const secret of banned) {
    assert.equal(encoded.includes(secret), false, secret);
  }
  return out;
}

test("the emitted WhatsApp feed has only a status of up or down", () => {
  assertOnlyStatus({ status: "up" }, "up");
  assertOnlyStatus({ status: "down" }, "down");
  assertOnlyStatus("up", "up");
  assertOnlyStatus("down", "down");
  assertOnlyStatus({ up: true }, "up");
  assertOnlyStatus({ up: false }, "down");
  assertOnlyStatus({ whatsapp_status: { status: "up" } }, "up");
  assertOnlyStatus({ whatsapp_status: "down" }, "down");
});

test("hostile input emits no message text, owner activity, guest name, or phone number", () => {
  const up = assertOnlyStatus(hostile({ status: "up", up: true }), "up");
  assert.deepEqual(up, { status: "up" });
  const down = assertOnlyStatus(hostile(), "down");
  assert.deepEqual(down, { status: "down" });
  const nested = hostile();
  nested.whatsapp_status = hostile({ status: "up" });
  assertOnlyStatus({
    schema: "sfdc24.fleet-public.v1",
    agents: [{ id: "claude", owner: OWNER, task: MESSAGE, phone: PHONES[4], last_seen: LAST_SEEN, guest: GUEST }],
    owner_last_seen: LAST_SEEN,
    whatsapp_status: nested.whatsapp_status
  }, "up");
});

test("a free-text status, a contradiction, or a missing flag fails closed to down", () => {
  assertOnlyStatus({ status: "up " + MESSAGE }, "down");
  assertOnlyStatus({ status: "UP" }, "down");
  assertOnlyStatus({ status: "up", up: false }, "down");
  assertOnlyStatus({ status: "down", up: true }, "down");
  assertOnlyStatus({ status: { status: "up", text: MESSAGE } }, "down");
  assertOnlyStatus({ up: "true", text: MESSAGE }, "down");
  assertOnlyStatus({ text: MESSAGE, sender: GUEST, at: ACTIVE_AT }, "down");
  assertOnlyStatus(null, "down");
  assertOnlyStatus([], "down");
  assertOnlyStatus({ whatsapp_status: null }, "down");
  const circular = hostile({ status: "up" });
  circular.self = circular;
  assertOnlyStatus(circular, "up");
});

test("phone numbers are absent from the emitted status, including formats the page filter kept", () => {
  const oldFilter = /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/;
  const keptByOldFilter = [
    "(416) 555-0199",
    "4165550199",
    "+14165550199",
    "+1 (416) 555-0199",
    "+44 20 7946 0958",
    "+44 7700 900123"
  ];
  const droppedByOldFilter = ["416-555-0199", "416.555.0199", "416 555 0199", "+1 416 555 0199"];
  for (const phone of keptByOldFilter) assert.equal(oldFilter.test(phone), false, phone);
  for (const phone of droppedByOldFilter) assert.equal(oldFilter.test(phone), true, phone);
  for (const phone of keptByOldFilter.concat(droppedByOldFilter)) {
    const out = JSON.stringify(projectWhatsappStatus({
      status: "up",
      text: "Call " + phone + " and ask for " + OWNER,
      sender: phone,
      guest: GUEST,
      phone: phone,
      last_seen: LAST_SEEN,
      away_since: AWAY_SINCE
    }));
    assert.equal(out, '{"status":"up"}');
    assert.equal(out.includes(phone), false, phone);
    assert.equal(out.includes(OWNER), false);
    assert.equal(out.includes(GUEST), false);
    assert.equal(out.includes(LAST_SEEN), false);
  }
});
