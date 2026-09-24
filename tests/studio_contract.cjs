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
const TYPES = new Set(env.properties.type.enum);

function all() {
  return [...fx.initial, ...Object.values(fx.on_command).flat()];
}

test("every event carries exactly the envelope and a known type", () => {
  for (const e of all()) {
    for (const k of env.required) assert.ok(k in e, `${e.op_id} missing ${k}`);
    for (const k of Object.keys(e)) assert.ok(k in env.properties, `${e.op_id} has unknown ${k}`);
    assert.ok(TYPES.has(e.type), `${e.op_id} type ${e.type}`);
    assert.equal(e.session_id, fx.session_id);
  }
});

test("seq is unique and op_id is unique across the whole script", () => {
  const seqs = all().map((e) => e.seq), ops = all().map((e) => e.op_id);
  assert.equal(new Set(seqs).size, seqs.length);
  assert.equal(new Set(ops).size, ops.length);
});

test("the script carries the traps the page must refuse", () => {
  const labels = JSON.stringify(fx);
  assert.match(labels, /STALE - must never render/);
  assert.match(labels, /OLD REVISION - must never render/);
  assert.match(labels, /onerror/);
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
    assert.ok(q.options.length >= 2 && q.options.length <= 3, q.question_id);
  }
});
