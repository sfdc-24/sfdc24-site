// The scripted session obeys its own contract. If the fixture drifts from the
// schema, the page gets built against a lie - so this runs before the page tests.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const DIR = path.join(__dirname, "..", "studio", "contract");
const schema = JSON.parse(fs.readFileSync(path.join(DIR, "events.schema.json"), "utf8"));
const fx = JSON.parse(fs.readFileSync(path.join(DIR, "fixtures", "scripted-session.json"), "utf8"));
const env = schema.$defs.envelope;
const PAYLOADS = schema.$defs.payloads;
const TYPES = new Set(env.properties.type.enum);
const TEMPLATE_KEYS = new Set(["type", "task_id", "task_revision", "turn_id", "payload",
  "artifact_version", "x_keep_version"]);

const templates = () => Object.values(fx.on_command).flat();
const all = () => [...fx.initial, ...templates()];

// A small closed-object checker: required keys present, nothing unlisted, and
// the nested question/option shapes the page renders. Not a full JSON Schema
// engine - enough to catch the drift Codex found (a batch_id the schema
// forbade, an empty payload the schema allowed).
function checkObject(obj, def, where) {
  assert.equal(typeof obj, "object", where);
  for (const k of def.required || []) assert.ok(k in obj, `${where} missing ${k}`);
  if (def.additionalProperties === false) {
    for (const k of Object.keys(obj)) assert.ok(k in def.properties, `${where} has unlisted ${k}`);
  }
}
function checkQuestion(q, where) {
  checkObject(q, schema.$defs.question, where);
  assert.ok(q.options.length >= 2 && q.options.length <= 3, `${where} options`);
  for (const o of q.options) checkObject(o, schema.$defs.option, `${where} option`);
}
function checkPayload(e) {
  const def = PAYLOADS[e.type];
  assert.ok(def, `no payload schema for ${e.type}`);
  checkObject(e.payload, def, `${e.type} payload`);
  if (e.payload.question) checkQuestion(e.payload.question, e.type);
  for (const q of e.payload.questions || []) checkQuestion(q, e.type);
  if (e.type === "decision.batch") {
    assert.ok(e.payload.questions.length >= 2 && e.payload.questions.length <= 4);
  }
  if (e.type === "artifact.patch") {
    assert.ok(e.payload.ops.length >= 1);
    for (const op of e.payload.ops) checkObject(op, schema.$defs.patch_op, "patch op");
  }
}

test("every event type has a closed payload schema", () => {
  for (const t of TYPES) assert.ok(PAYLOADS[t], t);
  for (const [t, def] of Object.entries(PAYLOADS)) {
    assert.equal(def.additionalProperties, false, t);
    assert.ok(def.required && def.required.length, `${t} requires nothing - an empty payload would pass`);
  }
});

test("initial events carry exactly the envelope, a known type and a valid payload", () => {
  for (const e of fx.initial) {
    for (const k of env.required) assert.ok(k in e, `${e.op_id} missing ${k}`);
    for (const k of Object.keys(e)) assert.ok(k in env.properties, `${e.op_id} has unknown ${k}`);
    assert.ok(TYPES.has(e.type));
    assert.equal(e.session_id, fx.session_id);
    checkPayload(e);
  }
  const seqs = fx.initial.map((e) => e.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1), "initial seq runs 1..n");
});

test("on_command events are templates: the transport stamps order and versions", () => {
  for (const e of templates()) {
    for (const k of Object.keys(e)) assert.ok(TEMPLATE_KEYS.has(k), `template has ${k}`);
    for (const k of ["seq", "op_id", "session_id", "generation"]) assert.ok(!(k in e), `template fixes ${k}`);
    assert.equal("artifact_version" in e, Boolean(e.x_keep_version),
      "only a trap may fix its version");
    assert.ok(TYPES.has(e.type));
    checkPayload(e);
  }
});

test("the script carries the traps the page must refuse", () => {
  const labels = JSON.stringify(fx);
  assert.match(labels, /STALE - must never render/);
  assert.match(labels, /OLD REVISION - must never render/);
  // The markup trap is injected by the page spec (typed data only), not
  // shipped in the walkthrough visitors see.
  assert.doesNotMatch(labels, /onerror|<img|<script/i);
  assert.equal(templates().filter((e) => e.x_keep_version).length, 2);
});

test("at most one recommended option per question, and it says why", () => {
  const questions = [];
  for (const e of all()) {
    if (e.payload.question) questions.push(e.payload.question);
    if (e.payload.questions) questions.push(...e.payload.questions);
  }
  assert.ok(questions.length >= 4);
  for (const q of questions) {
    const rec = q.options.filter((o) => o.recommended);
    assert.ok(rec.length <= 1, q.question_id);
    for (const o of rec) assert.ok(o.recommended_because, `${q.question_id} recommends without a reason`);
  }
});

test("the answer_batch command the page sends is allowed by the schema", () => {
  const cmd = schema.oneOf[1];
  for (const k of ["command_id", "session_id", "type", "expected_version", "batch_id", "answers"]) {
    assert.ok(k in cmd.properties, `command schema lacks ${k}`);
  }
});
