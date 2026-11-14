const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { projectWhatsappStatus } = require("../tools/fleet_whatsapp_guard.js");

const root = path.join(__dirname, "..");
const MESSAGE = "SENTINEL_MESSAGE_BODY";
const OWNER = "SENTINEL_OWNER_NAME";
const GUEST = "SENTINEL_GUEST_1";
const GUEST_2 = "SENTINEL_GUEST_2";
const PHONE = "+15550000000";
const ACTIVE_AT = "2000-01-01T00:00:00Z";
const AWAY_SINCE = "2000-01-02T00:00:00Z";
const LAST_SEEN = "2000-01-03T00:00:00Z";
const LAST_MESSAGE = "2000-01-04T00:00:00Z";

const PHONES = [
  PHONE,
  "555-010-0000",
  "555.010.0000",
  "555 010 0000",
  "(555) 010-0000",
  "5550100000",
  "+1 555 010 0000",
  "+15550100000",
  "+1 (555) 010-0000",
  "1-555-010-0000",
  "whatsapp:+15550000000"
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
    author: OWNER,
    guest: GUEST,
    guest_name: GUEST_2,
    phone: PHONE,
    phones: PHONES,
    at: ACTIVE_AT,
    active: true,
    active_at: ACTIVE_AT,
    away: true,
    away_since: AWAY_SINCE,
    presence: "SENTINEL_AWAY",
    last_seen: LAST_SEEN,
    lastSeen: LAST_SEEN,
    last_message_at: LAST_MESSAGE,
    last_message: MESSAGE
  }, extra || {});
}

function secrets() {
  return [MESSAGE, OWNER, GUEST, GUEST_2, ACTIVE_AT, AWAY_SINCE, LAST_SEEN, LAST_MESSAGE, "SENTINEL_AWAY"].concat(PHONES);
}

function assertOnlyStatus(raw, expected) {
  const out = projectWhatsappStatus(raw);
  assert.notEqual(out, raw);
  assert.deepEqual(Object.getOwnPropertyNames(out), ["status"]);
  assert.deepEqual(Object.keys(out), ["status"]);
  assert.equal(out.status, expected);
  assert.equal(JSON.stringify(out), '{"status":"' + expected + '"}');
  const encoded = JSON.stringify(out);
  for (const secret of secrets()) {
    assert.equal(encoded.includes(secret), false, secret);
  }
  return out;
}

function publishSnapshot(raw) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fleet-wa-"));
  const input = path.join(dir, "raw.json");
  const output = path.join(dir, "fleet-public.json");
  fs.writeFileSync(input, JSON.stringify(raw));
  execFileSync(process.execPath, [
    path.join(root, "tools", "fleet_whatsapp_guard.js"),
    "--in", input,
    "--out", output
  ], { cwd: root });
  return fs.readFileSync(output, "utf8");
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
    agents: [{ id: "claude", owner: OWNER, task: MESSAGE, phone: PHONE, last_seen: LAST_SEEN, guest: GUEST }],
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
    "(555) 010-0000",
    "5550100000",
    "+15550100000",
    "+1 (555) 010-0000",
    PHONE
  ];
  const droppedByOldFilter = ["555-010-0000", "555.010.0000", "555 010 0000", "+1 555 010 0000"];
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

test("the published snapshot from hostile input contains only status up or down", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "fleet-board.yml"), "utf8");
  assert.match(workflow, /node tools\/fleet_whatsapp_guard\.js --in data\/fleet-public\.json --out "\$RUNNER_TEMP\/fleet-public\.json"/);

  const raw = {
    schema: "sfdc24.fleet-public.v1",
    public_status: "live",
    transport: "poll",
    poll_seconds: 15,
    read_at: "2000-01-15T18:00:00Z",
    fresh_within_sec: 300,
    agents: [],
    text: MESSAGE,
    sender: OWNER,
    guest: GUEST,
    phone: PHONE,
    active_at: ACTIVE_AT,
    away_since: AWAY_SINCE,
    last_seen: LAST_SEEN,
    last_message_at: LAST_MESSAGE,
    whatsapp_status: hostile()
  };
  const downText = publishSnapshot(raw);
  const downDoc = JSON.parse(downText);
  assert.deepEqual(downDoc.whatsapp_status, { status: "down" });
  assert.deepEqual(Object.keys(downDoc.whatsapp_status), ["status"]);
  for (const secret of secrets()) assert.equal(downText.includes(secret), false, secret);

  const upRaw = Object.assign({}, raw, { whatsapp_status: hostile({ status: "up" }) });
  const upText = publishSnapshot(upRaw);
  const upDoc = JSON.parse(upText);
  assert.deepEqual(upDoc.whatsapp_status, { status: "up" });
  assert.equal(JSON.stringify(upDoc.whatsapp_status), '{"status":"up"}');
  for (const secret of secrets()) assert.equal(upText.includes(secret), false, secret);
});
