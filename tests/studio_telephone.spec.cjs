/* The telephone trail panel on /studio/ (step 4 of the broken-telephone fix).

   What it must do: stay hidden and silent unless a live session has a doc to show; render what the
   controller hands it as TEXT (states, who, when, the answer lines, the live state); say plainly
   when the trail is off, unreadable or empty; never fetch anything in fixture or walkthrough mode.
   The renderer cases run against ?script=fixture. The poll cases stand up a mock controller and
   advance the page clock, so the ten-second interval is not a real wait. */
const { test, expect } = require("@playwright/test");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.join(REPO, rel.replace(/^\/+/, ""));
    if (!file.startsWith(REPO) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); res.end("missing"); return;
    }
    res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () =>
    resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })));
}

let srv;
test.beforeAll(async () => {
  srv = process.env.STUDIO_BASE
    ? { server: null, origin: process.env.STUDIO_BASE.replace(/\/+$/, "") }
    : await startServer();
});
test.afterAll(async () => { srv && srv.server && srv.server.close(); });

async function open(page, query = "?script=fixture") {
  const external = [];
  page.on("request", (r) => { if (!r.url().startsWith(srv.origin)) external.push(r.url()); });
  await page.goto(srv.origin + "/studio/" + query);
  await expect(page.locator("#studio-artifact")).toHaveAttribute("data-artifact-version", "1");
  return external;
}

const DOC = "1pKWJYbJzMqxSA9Vy_PSR93BU2OAAgP-N3WBEkCj7oj4";
const TRAIL = {
  enabled: true, status: "ok", doc: DOC, task: "task-0123456789abcdef", request: "OT-20261010",
  entries: [
    { state: "REQUESTED", by: "drive-intake", at: "2026-10-11T04:00:00Z", detail: "", result: [] },
    { state: "DISPATCHED", by: "drive-intake", at: "2026-10-11T04:00:01Z",
      detail: "on fleet:inbox:claude-api, which the worker polls; no wake rung", result: [] },
    { state: "ACCEPTED", by: "claude-api", at: "2026-10-11T04:05:00Z", detail: "attempt 1", result: [] },
    { state: "SUCCEEDED", by: "claude-api", at: "2026-10-11T04:05:09Z", detail: "model x - 1 cents CAD",
      result: ["The answer.", "FOR THE LAPTOP:", "nothing"] }
  ],
  live: { laptop: "offline", api_worker: "online", intake: "dispatched", pending: true }
};

test("hidden and silent in fixture mode, even with a doc in the URL; the hook exists", async ({ page }) => {
  const external = await open(page, "?script=fixture&doc=" + DOC);
  await expect(page.locator("[data-studio-telephone]")).toBeHidden();
  expect(await page.evaluate(() => typeof window.__studio.telephone)).toBe("function");
  await page.waitForTimeout(300);
  expect(external, "fixture mode must not touch the network").toEqual([]);
});

test("renders the trail as text: every line in order, the answer under its line, the live state", async ({ page }) => {
  const external = await open(page);
  await page.evaluate((payload) => window.__studio.telephone(payload), TRAIL);
  const panel = page.locator("[data-studio-telephone]");
  await expect(panel).toBeVisible();
  const items = panel.locator("[data-studio-telephone-lines] li");
  await expect(items).toHaveCount(4);
  await expect(items.nth(0)).toContainText("REQUESTED");
  await expect(items.nth(0)).toContainText("by drive-intake at 2026-10-11T04:00:00Z");
  await expect(items.nth(1)).toContainText("which the worker polls");
  await expect(items.nth(3)).toHaveAttribute("data-telephone-state", "SUCCEEDED");
  const answer = panel.locator("[data-studio-telephone-answer]");
  await expect(answer).toBeVisible();
  await expect(answer).toContainText("The answer under SUCCEEDED:");
  await expect(answer.locator("p")).toHaveCount(4);
  await expect(answer.locator("p").nth(1)).toHaveText("The answer.");
  await expect(panel.locator("[data-studio-telephone-live]")).toHaveText(
    "Laptop offline, cloud worker online, intake dispatched, another pass due.");
  await expect(panel).not.toContainText(TRAIL.request);
  await expect(panel).not.toContainText(TRAIL.task);
  await expect(panel.locator("[data-studio-telephone-status]")).toBeHidden();
  expect(external).toEqual([]);
});

test("truncation labels from the trail are shown as text", async ({ page }) => {
  await open(page);
  await page.evaluate((payload) => window.__studio.telephone(payload), {
    status: "ok",
    entries: [{
      state: "SUCCEEDED", by: "claude-api", at: "t",
      detail: "note [cut here at 400 of 900 characters]",
      result: ["The answer.", "[answer cut here at 200 lines]"]
    }]
  });
  const panel = page.locator("[data-studio-telephone]");
  await expect(panel.locator("small")).toHaveText("note [cut here at 400 of 900 characters]");
  await expect(panel.locator("[data-studio-telephone-answer]")).toContainText("[answer cut here at 200 lines]");
});

test("typed data only: a detail or an answer that looks like HTML is shown as text", async ({ page }) => {
  await open(page);
  await page.evaluate((payload) => window.__studio.telephone(payload), {
    status: "ok", entries: [{ state: "SUCCEEDED", by: "<b>x</b>", at: "t", detail: "<img src=x onerror=alert(1)>",
      result: ["<script>alert(1)</script>"] }], live: null
  });
  const panel = page.locator("[data-studio-telephone]");
  await expect(panel.locator("[data-studio-telephone-lines] b, [data-studio-telephone-lines] img, [data-studio-telephone-answer] script")).toHaveCount(0);
  await expect(panel.locator("[data-studio-telephone-lines] small")).toHaveText("<img src=x onerror=alert(1)>");
  await expect(panel.locator("[data-studio-telephone-answer] p").nth(1)).toHaveText("<script>alert(1)</script>");
});

test("says plainly when the trail is off, unreadable, or empty, and clears a stale trail", async ({ page }) => {
  await open(page);
  const panel = page.locator("[data-studio-telephone]");
  const status = panel.locator("[data-studio-telephone-status]");
  await page.evaluate((payload) => window.__studio.telephone(payload), TRAIL);
  await expect(panel.locator("[data-studio-telephone-lines] li")).toHaveCount(4);
  await page.evaluate(() => window.__studio.telephone({ enabled: false }));
  await expect(status).toHaveText("The trail is not switched on for this studio.");
  await expect(panel.locator("[data-studio-telephone-lines] li")).toHaveCount(0);   // the stale trail is gone
  await expect(panel.locator("[data-studio-telephone-answer]")).toBeHidden();
  await page.evaluate(() => window.__studio.telephone({ status: "read_error", entries: [] }));
  await expect(status).toHaveText("The trail says: read error.");
  await page.evaluate(() => window.__studio.telephone({ status: "ok", entries: [] }));
  await expect(status).toHaveText("No receipts yet. The first one lands within two minutes of the doc.");
  await page.evaluate(() => window.__studio.telephone(null));
  await expect(status).toHaveText("The trail could not be read.");
  await page.evaluate(() => window.__studio.telephone({ status: "ok", entries: [null, "junk", { state: "QUEUED", by: "drive-intake", at: "t" }] }));
  await expect(panel.locator("[data-studio-telephone-lines] li")).toHaveCount(1);   // junk entries are skipped
});

test("no first person in the panel's own words", async ({ page }) => {
  await open(page);
  await page.evaluate((payload) => window.__studio.telephone(payload), { status: "ok", entries: [] });
  const words = await page.locator("[data-studio-telephone]").innerText();
  expect(words).not.toMatch(/\b(I|I'm|I've|my|me)\b/);
});

test("the walkthrough stays hidden and silent with a doc in the URL", async ({ page }) => {
  const external = await open(page, "?doc=" + DOC);
  await expect(page.locator("[data-studio-telephone]")).toBeHidden();
  expect(await page.evaluate(() => window.__studio)).toBeFalsy();
  await page.waitForTimeout(300);
  expect(external, "the walkthrough must not touch the network").toEqual([]);
});

function cors(req) {
  return {
    "access-control-allow-origin": req.headers.origin || "*",
    "access-control-allow-headers": "authorization, content-type, accept, last-event-id",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    vary: "origin"
  };
}

function listen(server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.requestTimeout = 0;
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        origin: `http://127.0.0.1:${server.address().port}`,
        close() {
          for (const socket of sockets) socket.destroy();
          return new Promise((done) => server.close(() => done()));
        }
      });
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, body, headers) {
  const payload = JSON.stringify(body);
  res.writeHead(status, Object.assign({
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  }, headers));
  res.end(payload);
}

function startPhoneController() {
  const hits = [];
  const phone = {
    status: 200,
    json: TRAIL,
    drop: false,
    hold: false,
    held: [],
    /* Answer every held read with the body it captured, then drop it. A read
       the page already aborted cannot be delivered; that is a discard too. */
    release() {
      const queued = this.held.splice(0, this.held.length);
      for (const item of queued) {
        if (item.res.writableEnded || item.res.destroyed) continue;
        try { sendJson(item.res, item.status, item.json, item.headers); }
        catch (err) { /* the page aborted this read */ }
      }
      return queued.length;
    }
  };
  const byCreation = new Map();
  let serial = 0;
  const streams = [];
  const ctl = {
    hits,
    phone,
    session: null,
    failNextEvents: 0,
    closeStreams() {
      const open = streams.splice(0, streams.length);
      for (const res of open) {
        try { res.end(); } catch (err) { /* already closed */ }
      }
    },
    pushEnded() {
      const event = {
        session_id: "sess-1",
        generation: 1,
        seq: 1,
        op_id: "end-1",
        type: "session.ended",
        task_id: "t-end",
        task_revision: 1,
        artifact_version: 0,
        turn_id: "turn-end",
        payload: { reason: "Time is up." }
      };
      const frame = "id: " + event.seq + "\nevent: " + event.type + "\ndata: " +
        JSON.stringify(event) + "\n\n";
      for (const res of streams) {
        try { res.write(frame); } catch (err) { /* already closed */ }
      }
    }
  };
  function issueSession(creationId) {
    const key = creationId || "";
    if (key && byCreation.has(key)) return byCreation.get(key);
    serial += 1;
    const session = {
      id: "sess-" + serial,
      token: serial === 1 ? "sess-token" : "sess-token-" + serial
    };
    if (key) byCreation.set(key, session);
    ctl.session = session;
    return session;
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const headers = cors(req);
    if (req.method === "OPTIONS") {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    hits.push({
      method: req.method,
      path: url.pathname,
      search: url.search,
      authorization: req.headers.authorization || ""
    });
    const parts = url.pathname.split("/").filter(Boolean);
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, features: { voice: false } }, headers);
      return;
    }
    if (req.method === "POST" && (url.pathname === "/v1/auth/start" || url.pathname === "/v1/auth/verify" ||
        url.pathname === "/v1/session" || parts[3] === "commands")) {
      readBody(req).then((raw) => {
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch (err) { body = {}; }
        if (url.pathname === "/v1/auth/start") {
          sendJson(res, 200, { challenge_id: "ch-1", expires_in: 600 }, headers);
          return;
        }
        if (url.pathname === "/v1/auth/verify") {
          if (String(body.code || "") !== "123456") {
            sendJson(res, 401, { detail: "code not accepted" }, headers);
            return;
          }
          sendJson(res, 200, { token: "op-token-2", expires_at: 2000000000 }, headers);
          return;
        }
        if (url.pathname === "/v1/session") {
          const session = issueSession(body.creation_id == null ? "" : String(body.creation_id));
          sendJson(res, 200, { session_id: session.id, token: session.token }, headers);
          return;
        }
        sendJson(res, 200, { ok: true, artifact_version: 0 }, headers);
      }).catch(() => {
        if (!res.writableEnded) sendJson(res, 500, { detail: "mock" }, headers);
      });
      return;
    }
    if (req.method === "GET" && parts[0] === "v1" && parts[1] === "session" && parts[3] === "events") {
      if (ctl.failNextEvents) {
        const status = ctl.failNextEvents;
        ctl.failNextEvents = 0;
        sendJson(res, status, { detail: "unauthorized" }, headers);
        return;
      }
      res.writeHead(200, Object.assign({
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store"
      }, headers));
      res.write(": keep-alive\n\n");
      streams.push(res);
      res.on("close", () => {
        const at = streams.indexOf(res);
        if (at >= 0) streams.splice(at, 1);
      });
      return;
    }
    if (req.method === "GET" && parts[0] === "v1" && parts[1] === "session" && parts[3] === "telephone") {
      if (phone.hold) {
        phone.held.push({
          res,
          status: phone.status,
          json: JSON.parse(JSON.stringify(phone.json)),
          headers
        });
        return;
      }
      if (phone.drop) {
        // Die after the status line so the page's read fails. Chromium may open
        // a second connection for that, so the test counts a new read, not an exact one.
        res.writeHead(200, Object.assign({ "content-type": "application/json; charset=utf-8" }, headers));
        res.destroy();
        return;
      }
      sendJson(res, phone.status, phone.json, headers);
      return;
    }
    res.writeHead(404, headers);
    res.end();
  });
  return listen(server).then((bound) => {
    bound.hits = hits;
    bound.phone = phone;
    bound.closeStreams = ctl.closeStreams;
    bound.pushEnded = ctl.pushEnded;
    Object.defineProperty(bound, "session", {
      get() { return ctl.session; }
    });
    Object.defineProperty(bound, "failNextEvents", {
      get() { return ctl.failNextEvents; },
      set(value) { ctl.failNextEvents = value; }
    });
    return bound;
  });
}

function startSite(controllerOrigin) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.join(REPO, rel.replace(/^\/+/, ""));
    if (!file.startsWith(REPO) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end("missing");
      return;
    }
    let body = fs.readFileSync(file);
    if (rel === "/studio/index.html") {
      body = Buffer.from(body.toString("utf8").replace(
        /data-controller-url="[^"]*"/,
        'data-controller-url="' + controllerOrigin + '"'
      ));
    }
    const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  });
  return listen(server);
}

function telephoneHits(ctl) {
  return ctl.hits.filter((hit) => hit.path.endsWith("/telephone"));
}

const CLOCK_START = Date.parse("2026-10-11T12:00:00Z");

async function openLive(page, { signedIn, query }) {
  const ctl = await startPhoneController();
  const site = await startSite(ctl.origin);
  await page.clock.install({ time: CLOCK_START });
  if (signedIn) {
    await page.addInitScript(() => {
      sessionStorage.setItem("studio.operator", JSON.stringify({
        token: "op-token",
        expires_at: 2000000000
      }));
    });
  }
  await page.goto(site.origin + "/studio/" + query);
  const clock = { at: CLOCK_START };
  return {
    ctl,
    /* Jump to a paused instant. The first jump has to clear the timer armed at
       load; later jumps are one poll interval, and each fires that poll once. */
    async tick(ms) {
      clock.at += ms;
      await page.clock.pauseAt(clock.at);
    },
    async close() {
      await site.close();
      await ctl.close();
    }
  };
}

test("a live page with a doc waits, and does not read the trail until a session is open", async ({ page }) => {
  const live = await openLive(page, { signedIn: false, query: "?live=1&doc=" + DOC });
  try {
    const panel = page.locator("[data-studio-telephone]");
    await expect(panel).toBeVisible();
    await expect(panel.locator("[data-studio-telephone-status]")).toHaveText("Waiting for the session.");
    await expect.poll(() => live.ctl.hits.some((hit) => hit.path === "/health")).toBe(true);
    await live.tick(30000);
    await live.tick(10000);
    await live.tick(10000);
    expect(telephoneHits(live.ctl)).toEqual([]);
  } finally {
    await live.close();
  }
});

test("a doc the controller would refuse never starts a read", async ({ page }) => {
  const live = await openLive(page, { signedIn: true, query: "?live=1&doc=short" });
  try {
    await expect.poll(() => live.ctl.hits.some((hit) => hit.path === "/v1/session/sess-1/events")).toBe(true);
    await expect(page.locator("[data-studio-telephone]")).toBeHidden();
    await live.tick(30000);
    await live.tick(10000);
    expect(telephoneHits(live.ctl)).toEqual([]);
  } finally {
    await live.close();
  }
});

test("an open session polls with its own token, and a failed poll clears the trail", async ({ page }) => {
  const live = await openLive(page, { signedIn: true, query: "?live=1&doc=" + DOC });
  try {
    await expect.poll(() => live.ctl.hits.some((hit) => hit.path === "/v1/session/sess-1/events")).toBe(true);
    expect(telephoneHits(live.ctl), "no read before the session is open").toEqual([]);

    await live.tick(30000);
    await expect.poll(() => telephoneHits(live.ctl).length).toBe(1);
    const hit = telephoneHits(live.ctl)[0];
    expect(hit.method).toBe("GET");
    expect(hit.path).toBe("/v1/session/sess-1/telephone");
    expect(hit.search).toBe("?doc=" + DOC);
    expect(hit.authorization).toBe("Bearer sess-token");

    const panel = page.locator("[data-studio-telephone]");
    const status = panel.locator("[data-studio-telephone-status]");
    const lines = panel.locator("[data-studio-telephone-lines] li");
    await expect(lines).toHaveCount(4);
    await expect(panel).not.toContainText(TRAIL.request);
    await expect(panel.locator("[data-studio-telephone-live]")).toHaveText(
      "Laptop offline, cloud worker online, intake dispatched, another pass due.");

    live.ctl.phone.status = 502;
    live.ctl.phone.json = { detail: "<b>drive-intake answered 500</b>" };
    await live.tick(10000);
    await expect.poll(() => telephoneHits(live.ctl).length).toBe(2);
    await expect(status).toHaveText("The trail could not be read (502). Trying again.");
    await expect(lines).toHaveCount(0);
    await expect(panel.locator("[data-studio-telephone-answer]")).toBeHidden();
    await expect(panel.locator("[data-studio-telephone-live]")).toHaveText("");
    await expect(panel.locator("b")).toHaveCount(0);

    live.ctl.phone.status = 200;
    live.ctl.phone.json = TRAIL;
    await live.tick(10000);
    await expect.poll(() => telephoneHits(live.ctl).length).toBe(3);
    await expect(lines).toHaveCount(4);

    live.ctl.phone.drop = true;
    const beforeDrop = telephoneHits(live.ctl).length;
    await live.tick(10000);
    await expect.poll(() => telephoneHits(live.ctl).length).toBeGreaterThan(beforeDrop);
    await expect(status).toHaveText("The trail could not be read. Trying again.");
    await expect(lines).toHaveCount(0);

    live.ctl.phone.drop = false;
    live.ctl.phone.status = 404;
    live.ctl.phone.json = { detail: "the telephone trail is off" };
    const beforeOff = telephoneHits(live.ctl).length;
    await live.tick(10000);
    await expect.poll(() => telephoneHits(live.ctl).length).toBe(beforeOff + 1);
    await expect(status).toHaveText("The trail is not switched on for this studio.");
    await expect(lines).toHaveCount(0);
    await expect(panel.locator("[data-studio-telephone-answer]")).toBeHidden();
  } finally {
    await live.close();
  }
});

function trailWith(detail) {
  return {
    enabled: true, status: "ok", doc: DOC,
    entries: [{
      state: "SUCCEEDED", by: "claude-api", at: "2026-10-11T04:05:09Z",
      detail: detail, result: ["Answer for " + detail]
    }],
    live: { laptop: "offline", api_worker: "online", intake: "idle", pending: false }
  };
}

async function storedTrail(page) {
  return page.evaluate(() => JSON.stringify(sessionStorage) + "\n" + JSON.stringify(localStorage));
}

async function showFirstTrail(page, live, detail) {
  live.ctl.phone.json = trailWith(detail);
  await expect.poll(() => live.ctl.hits.some((hit) => hit.path === "/v1/session/sess-1/events")).toBe(true);
  await live.tick(30000);
  await expect.poll(() => telephoneHits(live.ctl).length).toBe(1);
  const panel = page.locator("[data-studio-telephone]");
  await expect(panel).toContainText(detail);
  return panel;
}

test("ending a session clears the trail panel and its cached data", async ({ page }) => {
  const live = await openLive(page, { signedIn: true, query: "?live=1&doc=" + DOC });
  try {
    const panel = await showFirstTrail(page, live, "VISIBLE-BEFORE-END");
    live.ctl.phone.hold = true;
    live.ctl.phone.json = trailWith("LATE-AFTER-END");
    await live.tick(10000);
    await expect.poll(() => live.ctl.phone.held.length).toBe(1);
    live.ctl.pushEnded();
    await expect(panel).toBeHidden();
    expect(await panel.textContent()).not.toContain("VISIBLE-BEFORE-END");
    expect(await panel.locator("[data-studio-telephone-lines]").textContent()).toBe("");
    expect(await panel.locator("[data-studio-telephone-answer]").textContent()).toBe("");
    expect(await panel.locator("[data-studio-telephone-live]").textContent()).toBe("");
    live.ctl.phone.release();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await panel.textContent()).not.toContain("LATE-AFTER-END");
    expect(await panel.textContent()).not.toContain("VISIBLE-BEFORE-END");
    expect(await storedTrail(page)).not.toContain("VISIBLE-BEFORE-END");
    expect(await storedTrail(page)).not.toContain("LATE-AFTER-END");
  } finally {
    await live.close();
  }
});

test("signing out while a trail fetch is in flight discards that fetch", async ({ page }) => {
  const live = await openLive(page, { signedIn: true, query: "?live=1&doc=" + DOC });
  try {
    const panel = await showFirstTrail(page, live, "VISIBLE-BEFORE-SIGN-OUT");
    live.ctl.phone.hold = true;
    live.ctl.phone.json = trailWith("LATE-AFTER-SIGN-OUT");
    await live.tick(10000);
    await expect.poll(() => live.ctl.phone.held.length).toBe(1);
    const signOut = page.locator("[data-studio-signout]");
    await expect(signOut).toBeVisible();
    await signOut.click();
    await expect(panel).toBeHidden();
    expect(await panel.textContent()).not.toContain("VISIBLE-BEFORE-SIGN-OUT");
    live.ctl.phone.release();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await panel.textContent()).not.toContain("LATE-AFTER-SIGN-OUT");
    expect(await panel.textContent()).not.toContain("Answer for LATE-AFTER-SIGN-OUT");
    expect(await panel.locator("[data-studio-telephone-lines] li")).toHaveCount(0);
    expect(await storedTrail(page)).not.toContain("LATE-AFTER-SIGN-OUT");
    expect(await storedTrail(page)).not.toContain("VISIBLE-BEFORE-SIGN-OUT");
  } finally {
    await live.close();
  }
});

test("a late result from session N is ignored once session N+1 has started", async ({ page }) => {
  const live = await openLive(page, { signedIn: true, query: "?live=1&doc=" + DOC });
  try {
    const panel = await showFirstTrail(page, live, "RECEIPT-SESSION-1");
    live.ctl.phone.hold = true;
    live.ctl.phone.json = trailWith("LATE-FROM-SESSION-1");
    await live.tick(10000);
    await expect.poll(() => live.ctl.phone.held.length).toBe(1);
    live.ctl.failNextEvents = 401;
    live.ctl.closeStreams();
    await expect(page.locator("[data-studio-email]")).toBeVisible();
    expect(await panel.textContent()).not.toContain("RECEIPT-SESSION-1");
    await page.locator("[data-studio-email]").fill("operator@sfdc24.com");
    await page.locator("[data-studio-send-code]").click();
    await expect(page.locator("[data-studio-code]")).toBeVisible();
    await page.locator("[data-studio-code]").fill("123456");
    await page.locator("[data-studio-check-code]").click();
    await expect.poll(() => live.ctl.session && live.ctl.session.id).toBe("sess-2");
    await expect.poll(() => live.ctl.hits.some((hit) => hit.path === "/v1/session/sess-2/events")).toBe(true);
    live.ctl.phone.release();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await panel.textContent()).not.toContain("LATE-FROM-SESSION-1");
    expect(await panel.textContent()).not.toContain("RECEIPT-SESSION-1");
    live.ctl.phone.hold = false;
    live.ctl.phone.json = trailWith("FRESH-SESSION-2");
    const before = telephoneHits(live.ctl).length;
    await live.tick(10000);
    await expect.poll(() => telephoneHits(live.ctl).length).toBeGreaterThan(before);
    const fresh = telephoneHits(live.ctl).filter((hit) => hit.path === "/v1/session/sess-2/telephone");
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh[fresh.length - 1].authorization).toBe("Bearer sess-token-2");
    await expect(panel).toContainText("FRESH-SESSION-2");
    expect(await panel.textContent()).not.toContain("LATE-FROM-SESSION-1");
    expect(await panel.textContent()).not.toContain("RECEIPT-SESSION-1");
    expect(await storedTrail(page)).not.toContain("LATE-FROM-SESSION-1");
  } finally {
    await live.close();
  }
});

test("with STUDIO_TELEPHONE_URL unset the panel stays off and makes no telephone request", async ({ page }) => {
  // The controller's STUDIO_TELEPHONE_URL is unset unless that service is configured.
  // This page has no telephone URL of its own: without a doc it never calls /telephone.
  const live = await openLive(page, { signedIn: true, query: "?live=1" });
  try {
    await expect.poll(() => live.ctl.hits.some((hit) => hit.path === "/v1/session/sess-1/events")).toBe(true);
    await expect(page.locator("[data-studio-telephone]")).toBeHidden();
    await live.tick(30000);
    await live.tick(10000);
    await live.tick(10000);
    expect(telephoneHits(live.ctl)).toEqual([]);
  } finally {
    await live.close();
  }
});
