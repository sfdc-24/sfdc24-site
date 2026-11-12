// fleet:worker:assigned consumer on /xp/ (schema board 9018, plan 8964). Every value below is synthetic.
const { test, expect } = require("@playwright/test");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const READ_AT = "2026-10-19T02:30:00Z";
const CLOCK = Date.parse(READ_AT);
const T = "task-00000000000000a1";
const iso = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");
const dig = (c) => "sha256:" + c.repeat(64);
const basis = (kind, ago) => ({ kind: kind, digest: dig("a"), observed_at: ago == null ? null : iso(CLOCK - ago * 1000) });

function rec(over) {
  return Object.assign({
    schema_version: 1, task_id: T, producer: "drive-intake", lane: "drive-intake", revision: 3,
    observed_at: iso(CLOCK - 60000), assignment_state: "dispatched", route_target: "claude-api",
    delivered_principal: "claude-code-cli", accepted_principal: "claude-code-cli", effective_assignee: "claude-code-cli",
    attribution_state: "matched_acceptance", conflict_reason: null, conflict_basis: null,
    instance_id: null, session_id: null, identity_basis: "principal_only",
    source_basis: { delivery: basis("put_marker", 120), acceptance: basis("accept_key", 60), claim: null },
    blocker: null, waiting_for: "worker_completion", next_action: "observe_completion"
  }, over || {});
}
const observedOnly = (over) => rec(Object.assign({
  accepted_principal: null, effective_assignee: null, attribution_state: "delivery_observed",
  source_basis: { delivery: basis("put_marker", 120), acceptance: null, claim: null },
  waiting_for: "worker_acceptance", next_action: "observe_acceptance"
}, over || {}));
const conflict = (over) => observedOnly(Object.assign({
  attribution_state: "conflict", conflict_reason: "delivery_acceptance_mismatch",
  conflict_basis: { kind: "accept_key", digest: dig("b"), observed_at: iso(CLOCK - 30000), principal: "codex" },
  blocker: "assignee_conflict", waiting_for: "coordinator", next_action: "reconcile_assignment"
}, over || {}));
const acc = (p, ago, lease) => p + ":" + (CLOCK / 1000 - ago) + (lease ? ":" + lease : "");

async function serve(page) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://site.test") return route.abort();
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    if (rel === "/data/xp-live.json") return route.fulfill({ status: 404, body: "" });
    const file = path.resolve(root, "." + rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
    const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json" };
    return route.fulfill({ body: fs.readFileSync(file), contentType: types[path.extname(file)] || "text/plain" });
  });
}

async function asOwner(page) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = Buffer.from(JSON.stringify({ sid: "op", exp: exp, scope: "operator", v: 1 })).toString("base64url") + ".sig";
  await page.addInitScript((tok) => {
    sessionStorage.setItem("studio.operator", JSON.stringify({ token: tok, expires_at: "" }));
  }, token);
  await page.route("**/v1/session", (route) => route.fulfill({
    status: (route.request().headers()["authorization"] || "").indexOf(token) >= 0 ? 400 : 401,
    contentType: "application/json",
    body: "{}"
  }));
}

function norm(page, keys, extra) {
  return page.evaluate(([k, e]) => window.SFDC24Xp.normalize(Object.assign({ source: "fixture", read_at: "2026-10-19T02:30:00Z", keys: k }, e || {})), [keys, extra || null]);
}
const rowsOf = (t) => Object.fromEntries(t.rows);
const A = (r) => ({ ["fleet:worker:assigned:" + T]: typeof r === "string" ? r : JSON.stringify(r) });

test.beforeEach(async ({ page }) => {
  await serve(page);
  await asOwner(page);
  await page.goto("http://site.test/xp/?source=fixture");
});

test("critique case: routed to claude-api, delivered to and accepted by claude-code-cli is one assignment to claude-code-cli", async ({ page }) => {
  const m = await norm(page, Object.assign(A(rec()), { ["fleet:worker:accept:" + T]: acc("claude-code-cli", 30, 900) }));
  expect(m.tasks).toHaveLength(1);
  const t = m.tasks[0];
  expect([t.assign, t.conflict, t.by]).toEqual(["dispatched", false, "claude-code-cli"]);
  const r = rowsOf(t);
  expect(r["Routed to"]).toBe("claude-api");
  expect(r["Delivered to"]).toMatch(/^claude-code-cli \(/);
  expect(r["Accepted by"]).toMatch(/^claude-code-cli \(/);
  expect(r.Assignee).toBe("claude-code-cli");
  expect(r.Attribution).toBe("matched acceptance");
  expect(r["Live accept"]).toMatch(/^acceptance observed \(live key\): claude-code-cli /);
  expect(JSON.stringify(t)).not.toMatch(/reconciliation|disagree|mismatch/);
});

test("delivered but unaccepted keeps an empty assignee even when a live accept matches", async ({ page }) => {
  const m = await norm(page, Object.assign(A(observedOnly()), { ["fleet:worker:accept:" + T]: acc("claude-code-cli", 30, 900) }));
  const t = m.tasks[0];
  const r = rowsOf(t);
  expect([t.conflict, t.by, t.family]).toEqual([false, "", ""]);
  expect([r.Assignee, r["Accepted by"], r.Attribution]).toEqual(["unconfirmed", "acceptance not observed", "acceptance not observed"]);
  expect(r["Live accept"]).toMatch(/^acceptance observed \(live key\): claude-code-cli /);
  expect([t.blocker, t.waitingFor, t.next, t.work]).toEqual(["unknown", "worker_acceptance", "observe_acceptance", "Task " + T]);
});

test("a live accept from another principal marks the one card conflict without choosing it", async ({ page }) => {
  const m = await norm(page, Object.assign(A(observedOnly()), { ["fleet:worker:accept:" + T]: acc("codex", 30) }));
  expect(m.tasks).toHaveLength(1);
  const t = m.tasks[0];
  expect([t.conflict, t.by]).toEqual([true, ""]);
  expect(rowsOf(t)["Live accept"]).toMatch(/^conflict · reconciliation pending \(delivery_acceptance_mismatch\): codex /);
  expect(rowsOf(t).Assignee).toBe("unconfirmed");
});

test("acceptance table: older, equal and future live keys follow A2-A5", async ({ page }) => {
  const live = async (v) => { const t = (await norm(page, Object.assign(A(rec()), { ["fleet:worker:accept:" + T]: v }))).tasks[0]; return [t.conflict, (rowsOf(t)["Live accept"] || "").split(":")[0]]; };
  expect(await live(acc("claude-code-cli", 90))).toEqual([false, ""]);
  expect(await live(acc("claude-code-cli", 60))).toEqual([false, ""]);
  expect(await live(acc("codex", 60))).toEqual([true, "conflict · reconciliation pending (acceptance_records_disagree)"]);
  expect(await live(acc("codex", 90))).toEqual([false, ""]);
  expect(await live(acc("codex", -120))).toEqual([false, ""]);
  expect(await live("token-x:" + (CLOCK / 1000 - 10))).toEqual([false, ""]);
  expect(await live("codex:12a")).toEqual([false, ""]);
});

test("a stored conflict is one card reading reconciliation pending, never a guessed assignee", async ({ page }) => {
  const m = await norm(page, Object.assign(A(conflict()), { ["fleet:worker:accept:" + T]: acc("codex", 30) }));
  expect(m.tasks).toHaveLength(1);
  const t = m.tasks[0];
  const r = rowsOf(t);
  expect([t.conflict, t.by, r.Assignee]).toEqual([true, "", "none"]);
  expect(r.Attribution).toBe("conflict · reconciliation pending (delivery_acceptance_mismatch)");
  expect([t.blocker, t.waitingFor, t.next]).toEqual(["assignee_conflict", "coordinator", "reconcile_assignment"]);
});

test("an absent key differs from an unavailable one and keeps the frozen rows", async ({ page }) => {
  const legacy = { ["fleet:worker:accept:" + T]: acc("codex", 30, 900) };
  const absent = (await norm(page, legacy)).tasks[0];
  const bad = (await norm(page, Object.assign({}, legacy, A(rec({ extra: 1 }))))).tasks[0];
  const nonString = (await norm(page, Object.assign({}, legacy, { ["fleet:worker:assigned:" + T]: rec() }))).tasks[0];
  expect([absent.assign, absent.rows]).toEqual(["absent", []]);
  expect([bad.assign, bad.rows, bad.by]).toEqual(["unavailable", [["Assignment", "unavailable"]], "codex"]);
  expect(nonString.assign).toBe("unavailable");
  const { assign: a1, rows: r1, ...restA } = absent;
  const { assign: a2, rows: r2, ...restB } = bad;
  expect(restB).toEqual(restA);
});

test("every schema rule violation makes the whole record unavailable", async ({ page }) => {
  const cases = {
    missing: (() => { const r = rec(); delete r.lane; return r; })(),
    version: rec({ schema_version: 2 }), taskId: rec({ task_id: "task-00000000000000a2" }), producer: rec({ producer: "x" }),
    revision: rec({ revision: 0 }), revisionFloat: rec({ revision: 1.5 }), feb30: rec({ observed_at: "2026-02-30T00:00:00Z" }),
    future: rec({ observed_at: iso(CLOCK + 61000) }), state: rec({ assignment_state: "done" }), stateArray: rec({ assignment_state: ["dispatched"] }),
    i2: rec({ effective_assignee: "codex" }), i2b: observedOnly({ effective_assignee: "claude-code-cli" }),
    i3: conflict({ blocker: null }), i3b: rec({ conflict_reason: "delivery_acceptance_mismatch" }),
    i4: observedOnly({ accepted_principal: "claude-code-cli" }), i5: rec({ attribution_state: "unresolved", effective_assignee: null }),
    i6: rec({ instance_id: "inst-1" }), i6b: observedOnly({ identity_basis: "claimed_instance", instance_id: "inst-1", session_id: "s-1" }),
    i7: rec({ source_basis: { delivery: null, acceptance: basis("accept_key", 60), claim: null } }),
    i8: rec({ assignment_state: "queued", blocker: "laptop_unavailable", waiting_for: "assigned_worker", next_action: "await_worker_availability" }),
    i9: rec({ waiting_for: "worker_acceptance" }), i9empty: observedOnly({ blocker: "" }),
    i11: conflict({ conflict_basis: { kind: "put_marker", digest: dig("b"), observed_at: null, principal: "codex" } }),
    i12: rec({ source_basis: { delivery: basis("put_marker", 120), acceptance: basis("accept_key", null), claim: null } }),
    basisExtra: rec({ source_basis: { delivery: basis("put_marker", 120), acceptance: basis("accept_key", 60), claim: null, x: null } }),
    digest: rec({ source_basis: { delivery: { kind: "put_marker", digest: "sha256:AB", observed_at: null }, acceptance: basis("accept_key", 60), claim: null } }),
    unsafe: rec({ route_target: "token-lane" }), longRun: rec({ route_target: "abcdefghijklmnopqrstu" }), at: rec({ route_target: "a@b" }),
    upper: rec({ route_target: "Claude" })
  };
  const keys = {};
  const ids = Object.keys(cases).map((name, i) => {
    const id = "task-" + (0xb00 + i).toString(16).padStart(16, "0");
    keys["fleet:worker:assigned:" + id] = JSON.stringify(Object.assign(cases[name], { task_id: name === "taskId" ? cases[name].task_id : id }));
    return id;
  });
  keys["fleet:worker:assigned:task-0000000000000c99"] = JSON.stringify(rec({ task_id: "task-0000000000000c99", route_target: "x".repeat(1) })).padEnd(2049, " ");
  const m = await norm(page, keys);
  const got = Object.fromEntries(m.tasks.map((t) => [t.id, t.assign]));
  Object.keys(cases).forEach((name, i) => expect([name, got[ids[i]]]).toEqual([name, "unavailable"]));
  expect(got["task-0000000000000c99"]).toBe("unavailable");
});

test("valid variants pass: claimed instance, worker claim conflict and unknown recovery", async ({ page }) => {
  const ok = {
    "task-0000000000000d01": rec({ identity_basis: "claimed_instance", instance_id: "cli-88774585", session_id: "s.1" }),
    "task-0000000000000d02": rec({ assignment_state: "unknown", delivered_principal: null, accepted_principal: null, effective_assignee: null, attribution_state: "unresolved", source_basis: { delivery: null, acceptance: null, claim: null }, blocker: "recovery_unknown", waiting_for: "coordinator", next_action: "reconcile_assignment" }),
    "task-0000000000000d03": conflict({ conflict_reason: "worker_claim_unresolved", conflict_basis: { kind: "worker_claim", digest: dig("c"), observed_at: null, principal: null } }),
    "task-0000000000000d04": rec({ assignment_state: "queued", delivered_principal: null, accepted_principal: null, effective_assignee: null, attribution_state: "unresolved", source_basis: { delivery: null, acceptance: null, claim: basis("intake_claim", null) }, blocker: "laptop_unavailable", waiting_for: "assigned_worker", next_action: "await_worker_availability" })
  };
  const keys = {};
  Object.keys(ok).forEach((id) => { keys["fleet:worker:assigned:" + id] = JSON.stringify(Object.assign(ok[id], { task_id: id })); });
  const m = await norm(page, keys);
  expect(m.tasks.map((t) => [t.assign, t.conflict, t.by])).toEqual([["dispatched", false, "claude-code-cli"], ["unknown", false, ""], ["delivered", true, ""], ["queued", false, ""]].map((x, i) => i === 2 ? ["dispatched", true, ""] : x));
  expect(rowsOf(m.tasks[0]).Assignee).toBe("claude-code-cli (claimed cli-88774585/s.1)");
});

test("per-fact freshness: stale, time unknown and future facts are labeled", async ({ page }) => {
  const r = rec({ observed_at: iso(CLOCK - 7200000), source_basis: { delivery: basis("requested_receipt", null), acceptance: basis("accept_key", 7200), claim: null } });
  const t = (await norm(page, A(r))).tasks[0];
  const rows = rowsOf(t);
  expect(rows.Assignment).toBe("dispatched · stale");
  expect(rows["Delivered to"]).toBe("claude-code-cli (time unknown)");
  expect(rows["Accepted by"]).toBe("claude-code-cli (stale)");
  const fut = (await norm(page, A(rec({ source_basis: { delivery: basis("put_marker", -120), acceptance: basis("accept_key", 60), claim: null } })))).tasks[0];
  expect(rowsOf(fut)["Delivered to"]).toBe("claude-code-cli (unavailable)");
  const noClock = (await norm(page, A(rec()), { read_at: undefined })).tasks[0];
  expect(noClock.assign).toBe("unavailable");
});

test("assignment never changes settlement or output counts", async ({ page }) => {
  const base = {
    ["fleet:worker:accept:" + T]: acc("codex", 600, 900),
    ["fleet:worker:done:" + T]: JSON.stringify({ by: "codex", state: "SUCCEEDED", at: iso(CLOCK - 300000) }),
    "fleet:worker:done:task-00000000000000a2": "1"
  };
  const a = await norm(page, base);
  const b = await norm(page, Object.assign({}, base, A(rec()), { "fleet:worker:assigned:task-00000000000000a2": JSON.stringify(rec({ task_id: "task-00000000000000a2" })) }));
  expect(b.output).toEqual(a.output);
  expect(a.output.reported).toBe(true);
  expect(b.tasks.map((t) => [t.state, t.lease, t.output, t.at])).toEqual(a.tasks.map((t) => [t.state, t.lease, t.output, t.at]));
});

test("assigned keys outside the exact task pattern are ignored and an assigned-only task is listed", async ({ page }) => {
  const m = await norm(page, Object.assign(A(rec()), { "fleet:worker:assigned:task-XYZ": JSON.stringify(rec()), "fleet:worker:assigned:task-00000000000000A1": "{}" }));
  expect(m.tasks.map((t) => t.id)).toEqual([T]);
});

test("the card and detail render the separate labels, the conflict flag and no secrets", async ({ page }) => {
  await page.route("**/data/xp-fixture.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ read_at: READ_AT, keys: Object.assign(A(conflict()), {
    "fleet:worker:assigned:task-00000000000000e1": JSON.stringify(rec({ task_id: "task-00000000000000e1", route_target: "secret-lane" }))
  }) }) }));
  await page.goto("http://site.test/xp/?source=fixture");
  await expect(page.locator(".xp-task")).toHaveCount(2);
  await expect(page.locator("[data-xp-id='" + T + "'] small")).toHaveText("unknown · Conflict · Assignment dispatched");
  await expect(page.locator("body")).not.toContainText("secret-lane");
  await page.locator("[data-xp-id='" + T + "']").click();
  const dl = await page.locator("#xp-detail-body").evaluate((d) => [...d.querySelectorAll("dt")].map((x) => [x.textContent, x.nextElementSibling.textContent]));
  const rows = Object.fromEntries(dl);
  expect(rows).toMatchObject({ "Routed to": "claude-api", "Delivered to": expect.stringMatching(/^claude-code-cli \(/), "Accepted by": "acceptance not observed", Assignee: "none", Attribution: "conflict · reconciliation pending (delivery_acceptance_mismatch)" });
});

// Round 2 (verifier round 1/3 HOLD, F3-F8). Each case reproduces the verifier's failing evidence.
const queued = (over) => rec(Object.assign({ assignment_state: "queued", delivered_principal: null, accepted_principal: null, effective_assignee: null, attribution_state: "unresolved", source_basis: { delivery: null, acceptance: null, claim: basis("intake_claim", null) }, blocker: "laptop_unavailable", waiting_for: "assigned_worker", next_action: "await_worker_availability" }, over || {}));

test("F3: a newer contradictory live accept drops the resolved current owner and the completion wait", async ({ page }) => {
  const m = await norm(page, Object.assign(A(rec({ effective_assignee: "claude-api", delivered_principal: "claude-api", accepted_principal: "claude-api" })), { ["fleet:worker:accept:" + T]: acc("claude-code-cli", 30) }));
  const t = m.tasks[0];
  const r = rowsOf(t);
  expect([t.conflict, t.by, t.family]).toEqual([true, "", ""]);
  expect([t.blocker, t.waitingFor, t.next]).toEqual(["assignee_conflict", "coordinator", "reconcile_assignment"]);
  expect(r.Assignee).toBe("unresolved; recorded claude-api is historical");
  expect(r.Attribution).toBe("conflict · reconciliation pending (acceptance_records_disagree)");
  expect(r["Accepted by"]).toMatch(/^claude-api /);
});

test("F4: a queued record keeps its validated lane and the overview shows the assignment state", async ({ page }) => {
  const t = (await norm(page, A(queued()))).tasks[0];
  expect([t.lane, t.state, t.assign]).toEqual(["drive-intake", "unknown", "queued"]);
  const done = (await norm(page, Object.assign(A(queued()), { ["fleet:worker:done:" + T]: JSON.stringify({ by: "codex", lane: "site", state: "SUCCEEDED", at: iso(CLOCK - 300000) }) }))).tasks[0];
  expect(done.lane).toBe("site");
  await page.route("**/data/xp-fixture.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ read_at: READ_AT, keys: A(queued()) }) }));
  await page.goto("http://site.test/xp/?source=fixture");
  await expect(page.locator("[data-xp-id='" + T + "'] small")).toHaveText("unknown · Assignment queued");
});

test("F5: a null blocker reads unknown, never an asserted none", async ({ page }) => {
  const t = (await norm(page, A(observedOnly()))).tasks[0];
  expect(t.blocker).toBe("unknown");
  expect((await norm(page, A(queued()))).tasks[0].blocker).toBe("laptop_unavailable");
});

test("F6: a session-only claimed instance shows the session and leaves the instance unknown", async ({ page }) => {
  const who = async (over) => rowsOf((await norm(page, A(rec(over)))).tasks[0]).Assignee;
  expect(await who({ identity_basis: "claimed_instance", instance_id: null, session_id: "main-synth-01" })).toBe("claude-code-cli (claimed unknown/main-synth-01)");
  expect(await who({ identity_basis: "claimed_instance", instance_id: "cli-synth-1", session_id: null })).toBe("claude-code-cli (claimed cli-synth-1/unknown)");
  expect(await who({})).toBe("claude-code-cli");
});

test("F7: a legacy settled marker stops the current completion wait without inferring success", async ({ page }) => {
  const m = await norm(page, Object.assign(A(rec()), { ["fleet:worker:accept:" + T]: acc("claude-code-cli", 60, 900), ["fleet:worker:done:" + T]: "1" }));
  const t = m.tasks[0];
  expect([t.lease, t.waiting, t.state, t.output]).toEqual(["settled", false, "unknown", ""]);
  expect([t.blocker, t.waitingFor, t.next]).toEqual(["unknown", "unknown", "unknown"]);
  expect(m.output.reported).toBe(false);
});

test("F8: malformed Unicode makes only that record unavailable and the view still renders", async ({ page }) => {
  const bad = '{"malformed":"' + String.fromCharCode(0xd800) + '"}';
  const m = await norm(page, Object.assign(A(bad), { "fleet:worker:assigned:task-00000000000000a2": JSON.stringify(rec({ task_id: "task-00000000000000a2" })) }));
  expect(m.tasks.map((t) => [t.id, t.assign])).toEqual([[T, "unavailable"], ["task-00000000000000a2", "dispatched"]]);
  expect((await norm(page, A("x".repeat(2049)))).tasks[0].assign).toBe("unavailable");
  await page.route("**/data/xp-fixture.json", (route) => route.fulfill({ status: 200, contentType: "application/json", body: '{"read_at":"' + READ_AT + '","keys":{"fleet:worker:assigned:' + T + '":"{\\"malformed\\":\\"\\ud800\\"}"}}' }));
  await page.goto("http://site.test/xp/?source=fixture");
  await expect(page.locator(".xp-task")).toHaveCount(1);
});
