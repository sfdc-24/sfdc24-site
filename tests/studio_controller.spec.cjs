// Live transport: the page talks to a controller, not the fixture file.
// A Node mock implements POST /v1/session, the event stream, and commands
// using the scripted session's initial events and on_command templates.
// It stamps seq, op_id, and versions the way the fixture transport does.
const { test, expect } = require("@playwright/test");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const REPO = path.join(__dirname, "..");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(REPO, "studio/contract/fixtures/scripted-session.json"), "utf8"));
const SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO, "studio/contract/events.schema.json"), "utf8"));
const COMMAND = SCHEMA.oneOf[1];
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

test.describe.configure({ mode: "serial", timeout: 30000 });

function listen(server) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.requestTimeout = 0;
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const origin = `http://127.0.0.1:${server.address().port}`;
      resolve({
        server,
        origin,
        close() {
          for (const socket of sockets) socket.destroy();
          return new Promise((done) => server.close(() => done()));
        }
      });
    });
  });
}

function cors(req) {
  return {
    "access-control-allow-origin": req.headers.origin || "*",
    "access-control-allow-headers": "authorization, content-type, accept, last-event-id",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-expose-headers": "retry-after",
    "access-control-max-age": "600",
    vary: "origin"
  };
}

function writeJson(req, res, status, body, extra) {
  const payload = JSON.stringify(body);
  res.writeHead(status, Object.assign({
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store"
  }, extra || {}, cors(req)));
  res.end(payload);
}

function writeBusy(req, res, once) {
  const body = { detail: "capacity" };
  const extra = {};
  if (once && once.retry_after != null) body.retry_after = once.retry_after;
  if (once && once.header != null) extra["retry-after"] = String(once.header);
  writeJson(req, res, 429, body, extra);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function commandKey(command) {
  if (command.type === "answer") return "answer:" + command.question_id + ":" + (command.option_id || "");
  if (command.type === "change_decision") return "change_decision:" + command.question_id;
  if (command.type === "answer_batch") return "answer_batch:" + (command.batch_id || "");
  return command.type || "";
}

function cloneRoot() {
  const snap = FIXTURE.initial.find((event) => event.type === "artifact.snapshot");
  return JSON.parse(JSON.stringify(snap.payload.root));
}

function setLabel(node, id, label) {
  if (!node) return;
  if (node.id === id) node.label = label;
  for (const child of node.children || []) setLabel(child, id, label);
}

function encodeSSE(event) {
  // Pretty JSON is several data: lines. The page has to join them.
  const json = JSON.stringify(event, null, 2);
  const data = json.split("\n").map((line) => "data: " + line).join("\n");
  return `: keep-alive\nid: ${event.seq}\nevent: ${event.type}\n${data}\n\n`;
}

function firstIndexAfter(events, lastId) {
  if (!lastId) return 0;
  if (!/^\d+$/.test(String(lastId))) return -1;
  const seq = Number(lastId);
  let newest = 0;
  for (const event of events) if (event.generation > newest) newest = event.generation;
  const newestHasSeq = events.some((event) => event.generation === newest && event.seq === seq);
  if (!newestHasSeq) {
    const at = events.findIndex((event) => event.generation === newest);
    return at < 0 ? events.length : at;
  }
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.generation === newest && event.seq > seq) return i;
  }
  return events.length;
}

function stamp(session, template) {
  const event = JSON.parse(JSON.stringify(template));
  const keep = !!event.x_keep_version;
  delete event.x_keep_version;
  event.session_id = session.id;
  event.generation = session.generation;
  event.seq = ++session.seq;
  event.op_id = "op-" + session.generation + "-" + event.seq;
  if (!keep) {
    if (event.type === "artifact.patch") event.artifact_version = session.artifactVersion + 1;
    else if (typeof event.artifact_version !== "number") event.artifact_version = session.artifactVersion;
    if (session.taskRevision && typeof event.task_revision === "number" && event.task_revision < session.taskRevision) {
      event.task_revision = session.taskRevision;
    }
    if (typeof event.artifact_version === "number" && event.artifact_version > session.artifactVersion) {
      session.artifactVersion = event.artifact_version;
    }
    if (typeof event.task_revision === "number" && event.task_revision > session.taskRevision) {
      session.taskRevision = event.task_revision;
    }
  }
  return event;
}

function startController() {
  const ctl = {
    session: null,
    requests: [],
    commands: [],
    resumes: [],
    droppedAt: "",
    dropBudget: null,
    failStart: null,
    failStartOnce: null,
    failEvents: 0,
    failEventsOnce: null,
    operators: new Map(),
    challenges: new Map(),
    byCreation: new Map(),
    authStarts: [],
    authReplies: [],
    starts: [],
    eventWrites: 0,
    closedAt: 0,
    commandOverride: null,
    emptyClose: false,
    voiceEnabled: false,
    healthStatus: 200,
    omitHealth: false,
    voiceStatus: 200,
    voiceEndsAt: null,
    voiceDrop: false,
    voicePosts: [],
    armDrop(n) { this.dropBudget = n; },
    desync(version) { this.session.artifactVersion = version; },
    restart() { restart(this); },
    recover() { recover(this); },
    issueOperator() {
      const token = "op" + crypto.randomBytes(16).toString("hex");
      this.operators.set(token, {
        email: "operator@sfdc24.com",
        expires_at: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString()
      });
      return token;
    },
    closeOpenStreams() {
      const session = this.session;
      if (!session) return;
      this.closedAt = Date.now();
      const clients = session.clients.splice(0, session.clients.length);
      for (const client of clients) {
        try { client.res.end(); } catch (err) { /* already closed */ }
      }
    }
  };

  function endClient(client) {
    const clients = ctl.session.clients;
    const at = clients.indexOf(client);
    if (at >= 0) clients.splice(at, 1);
    try { client.res.end(); } catch (err) { /* already closed */ }
  }

  function flush(client) {
    const session = ctl.session;
    while (client.index < session.events.length) {
      const event = session.events[client.index];
      client.res.write(encodeSSE(event));
      client.index += 1;
      ctl.eventWrites += 1;
      if (ctl.dropBudget != null) {
        ctl.dropBudget -= 1;
        if (ctl.dropBudget <= 0) {
          ctl.dropBudget = null;
          ctl.droppedAt = String(event.seq);
          endClient(client);
          return;
        }
      }
    }
  }

  function broadcast() {
    for (const client of ctl.session.clients.slice()) flush(client);
  }

  ctl.endSession = function () {
    const session = ctl.session;
    if (!session) return;
    session.events.push(stamp(session, {
      type: "session.ended",
      task_id: "t-home",
      task_revision: Math.max(session.taskRevision, 1),
      artifact_version: session.artifactVersion,
      turn_id: "turn-end",
      payload: { reason: "The session is over." }
    }));
    broadcast();
  };

  function restart(target) {
    const session = target.session;
    session.generation = 2;
    session.seq = 0;
    const root = cloneRoot();
    setLabel(root, "hero-heading", "Rebuilt after a restart");
    session.events.push(stamp(session, {
      type: "artifact.snapshot",
      task_id: "t-home",
      task_revision: Math.max(session.taskRevision, 1),
      artifact_version: 7,
      turn_id: "turn-restart",
      payload: { root }
    }));
    const clients = session.clients.splice(0, session.clients.length);
    for (const client of clients) {
      try { client.res.end(); } catch (err) { /* already closed */ }
    }
  }

  function recover(target) {
    const session = target.session;
    const root = cloneRoot();
    setLabel(root, "hero-heading", "Caught up");
    session.events.push(stamp(session, {
      type: "artifact.snapshot",
      task_id: "t-home",
      task_revision: Math.max(session.taskRevision, 1),
      artifact_version: session.artifactVersion,
      turn_id: "turn-sync",
      payload: { root }
    }));
    broadcast();
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    ctl.requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization || "",
      lastEventId: req.headers["last-event-id"] || "",
      at: Date.now()
    });
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors(req));
      res.end();
      return;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    handle(req, res, url, parts).catch((err) => {
      if (!res.headersSent) writeJson(req, res, 500, { error: "mock", detail: String(err && err.message || err) });
      else {
        try { res.end(); } catch (closeErr) { /* already closed */ }
      }
    });
  });

  function bearer(req) {
    const header = req.headers.authorization || "";
    const match = /^Bearer (.+)$/.exec(header);
    return match ? match[1] : "";
  }

  function sessionPayload(session) {
    return {
      session_id: session.id,
      generation: session.generation,
      artifact_version: session.artifactVersion,
      expires_at: session.expiresAt,
      max_session_seconds: 600,
      daily_admission_number: ctl.byCreation.size,
      token: session.token,
      events_url: "/v1/session/" + session.id + "/events"
    };
  }

  async function handle(req, res, url, parts) {
    if (req.method === "GET" && url.pathname === "/v1/health") {
      if (ctl.omitHealth) {
        writeJson(req, res, 404, { detail: "not found" });
        return;
      }
      if (ctl.healthStatus !== 200) {
        writeJson(req, res, ctl.healthStatus, { detail: "unavailable" });
        return;
      }
      writeJson(req, res, 200, {
        ok: true,
        worker: "mock",
        state_backend: "memory",
        features: { voice: ctl.voiceEnabled === true }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/auth/start") {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw); } catch (err) { body = {}; }
      const challengeId = "ch" + crypto.randomBytes(8).toString("hex");
      ctl.challenges.set(challengeId, {
        email: String(body.email || ""),
        client_key: String(body.client_key || "")
      });
      const reply = { challenge_id: challengeId, expires_in: 600 };
      ctl.authStarts.push({ email: body.email, client_key: body.client_key });
      ctl.authReplies.push(reply);
      writeJson(req, res, 200, reply);
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/auth/verify") {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw); } catch (err) { body = {}; }
      const challenge = ctl.challenges.get(body.challenge_id);
      const ok = challenge &&
        challenge.email === "operator@sfdc24.com" &&
        body.email === challenge.email &&
        body.client_key === challenge.client_key &&
        String(body.client_key || "").length >= 32 &&
        body.code === "123456";
      if (!ok) {
        writeJson(req, res, 401, { detail: "code not accepted" });
        return;
      }
      const token = "op" + crypto.randomBytes(16).toString("hex");
      const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
      ctl.operators.set(token, { email: challenge.email, expires_at: expiresAt });
      writeJson(req, res, 200, { token, expires_at: expiresAt, scope: "operator" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/v1/session") {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw); } catch (err) { body = {}; }
      const creationId = body.creation_id == null ? "" : String(body.creation_id);
      ctl.starts.push({
        authorization: req.headers.authorization || "",
        creation_id: creationId
      });
      if (ctl.failStartOnce) {
        const once = ctl.failStartOnce;
        ctl.failStartOnce = null;
        if (once.status && once.status !== 429) {
          writeJson(req, res, once.status, once.body || { detail: "unauthorized" });
          return;
        }
        writeBusy(req, res, once);
        return;
      }
      if (ctl.failStart) {
        writeJson(req, res, ctl.failStart.status, ctl.failStart.body || { detail: "refused" });
        return;
      }
      if (!ctl.operators.has(bearer(req))) {
        writeJson(req, res, 401, { detail: "operator token missing or expired" });
        return;
      }
      if (creationId && ctl.byCreation.has(creationId)) {
        const existing = ctl.byCreation.get(creationId);
        ctl.session = existing;
        writeJson(req, res, 200, sessionPayload(existing));
        return;
      }
      const session = {
        id: "s" + crypto.randomBytes(8).toString("hex"),
        token: "t" + crypto.randomBytes(16).toString("hex"),
        generation: 1,
        seq: 0,
        artifactVersion: 0,
        taskRevision: 0,
        events: [],
        clients: [],
        seen: new Map(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString()
      };
      ctl.session = session;
      for (const template of FIXTURE.initial) session.events.push(stamp(session, template));
      if (creationId) ctl.byCreation.set(creationId, session);
      writeJson(req, res, 200, sessionPayload(session));
      return;
    }

    const session = ctl.session;
    const isSession = parts[0] === "v1" && parts[1] === "session" && parts[2] && parts[3];
    if (!isSession || !session || parts[2] !== session.id) {
      writeJson(req, res, 404, { detail: "session gone" });
      return;
    }
    const authed = req.headers.authorization === "Bearer " + session.token;

    if (req.method === "GET" && parts[3] === "events") {
      if (ctl.failEvents) {
        writeJson(req, res, ctl.failEvents, { detail: "refused" });
        return;
      }
      if (!authed) {
        const token = bearer(req);
        const foreign = token && token !== session.token && [...ctl.byCreation.values()].some((item) => item.token === token);
        writeJson(req, res, foreign ? 403 : 401, { detail: foreign ? "token belongs to another session" : "unauthorized" });
        return;
      }
      if (ctl.failEventsOnce) {
        const once = ctl.failEventsOnce;
        ctl.failEventsOnce = null;
        writeBusy(req, res, once);
        return;
      }
      const last = req.headers["last-event-id"] || "";
      if (last && !/^\d+$/.test(last)) {
        writeJson(req, res, 400, { detail: "Last-Event-ID must be an integer" });
        return;
      }
      if (last) ctl.resumes.push(last);
      if (ctl.emptyClose) {
        res.writeHead(200, Object.assign({
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no"
        }, cors(req)));
        res.end();
        return;
      }
      res.writeHead(200, Object.assign({
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no"
      }, cors(req)));
      if (res.socket) res.socket.setNoDelay(true);
      const client = { res, index: firstIndexAfter(session.events, last) };
      session.clients.push(client);
      flush(client);
      return;
    }

    if (req.method === "POST" && parts[3] === "voice") {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw); } catch (err) { body = {}; }
      ctl.voicePosts.push({
        url: req.url,
        authorization: req.headers.authorization || "",
        sdp: body.sdp
      });
      if (!authed) {
        writeJson(req, res, 401, { detail: "unauthorized" });
        return;
      }
      if (ctl.voiceDrop) {
        req.on("error", function () {});
        res.on("error", function () {});
        res.destroy();
        return;
      }
      const status = ctl.voiceStatus || 200;
      if (status !== 200) {
        const detail = status === 409 ? "voice_active" : status === 410 ? "session over" : "provider refused";
        writeJson(req, res, status, { detail });
        return;
      }
      writeJson(req, res, 200, {
        sdp: "v=0\r\nanswer-sdp",
        voice_id: "voice-test",
        ends_at: ctl.voiceEndsAt || new Date(Date.now() + 10 * 60 * 1000).toISOString()
      });
      return;
    }

    if (req.method === "POST" && parts[3] === "commands") {
      const raw = await readBody(req);
      if (!authed) {
        writeJson(req, res, 401, { detail: "unauthorized" });
        return;
      }
      let command;
      try { command = JSON.parse(raw); } catch (err) { command = null; }
      if (!command || typeof command !== "object" || !command.command_id) {
        writeJson(req, res, 400, { detail: "invalid command" });
        return;
      }
      const prior = session.seen.get(command.command_id);
      if (prior) {
        ctl.commands.push({ body: command, authorization: req.headers.authorization, status: prior.status, response: prior.body, url: req.url });
        writeJson(req, res, prior.status, prior.body);
        return;
      }
      if (ctl.commandOverride) {
        const over = ctl.commandOverride;
        ctl.commandOverride = null;
        const status = over.status || 409;
        const body = over.body || { detail: "conflict" };
        session.seen.set(command.command_id, { status, body });
        ctl.commands.push({ body: command, authorization: req.headers.authorization, status, response: body, url: req.url });
        writeJson(req, res, status, body);
        return;
      }
      if (command.expected_version !== session.artifactVersion) {
        const body = { detail: "stale expected_version" };
        session.seen.set(command.command_id, { status: 409, body });
        ctl.commands.push({ body: command, authorization: req.headers.authorization, status: 409, response: body, url: req.url });
        writeJson(req, res, 409, body);
        return;
      }
      const templates = (FIXTURE.on_command && FIXTURE.on_command[commandKey(command)]) || [];
      for (const template of templates) session.events.push(stamp(session, template));
      const body = {
        command_id: command.command_id,
        session_id: session.id,
        artifact_version: session.artifactVersion,
        events: [],
        problems: []
      };
      session.seen.set(command.command_id, { status: 200, body });
      ctl.commands.push({ body: command, authorization: req.headers.authorization, status: 200, response: body, url: req.url });
      writeJson(req, res, 200, body);
      broadcast();
      return;
    }

    writeJson(req, res, 404, { detail: "session gone" });
  }

  return listen(server).then((bound) => {
    ctl.origin = bound.origin;
    ctl.close = bound.close;
    return ctl;
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
      const html = body.toString("utf8").replace(
        'data-controller-url=""',
        'data-controller-url="' + controllerOrigin + '"'
      );
      body = Buffer.from(html);
    }
    const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  });
  return listen(server);
}

function assertCommand(command, sessionId) {
  expect(COMMAND.title).toBe("command");
  for (const key of COMMAND.required) expect(command, "missing " + key).toHaveProperty(key);
  for (const key of Object.keys(command)) {
    expect(COMMAND.properties, "unlisted " + key).toHaveProperty(key);
  }
  expect(COMMAND.properties.type.enum).toContain(command.type);
  expect(Number.isInteger(command.expected_version)).toBe(true);
  expect(command.expected_version).toBeGreaterThanOrEqual(0);
  expect(command.session_id).toBe(sessionId);
  expect(command.command_id).toMatch(/^[A-Za-z0-9._:-]{1,80}$/);
  if (command.answer_source) expect(COMMAND.properties.answer_source.enum).toContain(command.answer_source);
}

function assertTokenNotInUrls(urls, token) {
  for (const url of urls) {
    const parsed = new URL(url, "http://127.0.0.1");
    if (token) expect(url, url).not.toContain(token);
    for (const [key, value] of parsed.searchParams) {
      expect(key.toLowerCase()).not.toMatch(/token|authorization|bearer/);
      if (token) expect(value).not.toContain(token);
    }
    expect(parsed.username).toBe("");
    expect(parsed.password).toBe("");
  }
}

let ctl;
let site;

test.beforeEach(async () => {
  ctl = await startController();
  site = await startSite(ctl.origin);
});

test.afterEach(async () => {
  if (site) await site.close();
  if (ctl) await ctl.close();
  site = null;
  ctl = null;
});

function track(page) {
  const urls = [];
  page.on("request", (req) => urls.push(req.url()));
  return urls;
}

function assertClean(urls) {
  const token = ctl.session && ctl.session.token;
  assertTokenNotInUrls(urls, token);
  assertTokenNotInUrls(ctl.requests.map((req) => new URL(req.url, ctl.origin).href), token);
}

async function seedOperator(page) {
  const token = ctl.issueOperator();
  const stored = JSON.stringify({
    token,
    expires_at: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString()
  });
  await page.addInitScript((value) => {
    sessionStorage.setItem("studio.operator", value);
  }, stored);
  return token;
}

async function openStudio(page, search) {
  await seedOperator(page);
  const urls = track(page);
  await page.goto(site.origin + "/studio/" + (search || ""));
  await expect(page.locator('[data-studio-card][data-question-id="q-cta"]')).toBeVisible();
  return urls;
}

async function answer(page) {
  await page.locator('[data-studio-card][data-question-id="q-cta"]')
    .getByRole("button", { name: /Describe a problem/ }).click();
}

test("answer, patch, and confirm round-trip over the wire", async ({ page }) => {
  const urls = await openStudio(page, "?controller=http://127.0.0.1:9");
  await answer(page);
  await expect(page.locator("#studio-artifact")).toHaveAttribute("data-artifact-version", "2");
  await expect(page.locator('[data-node-id="hero-cta"]')).toContainText("Describe a problem");
  await expect(page.locator("[data-studio-confirm]")).toHaveText(
    "Using Describe a problem. The hero action now opens guided intake.");
  await expect(page.locator("body")).not.toContainText("STALE");
  expect(ctl.commands).toHaveLength(1);
  expect(ctl.commands[0].status).toBe(200);
  assertClean(urls);
});

test("commands carry the bearer and match the command schema", async ({ page }) => {
  const urls = await openStudio(page);
  await answer(page);
  await expect(page.locator("#studio-artifact")).toHaveAttribute("data-artifact-version", "2");
  expect(ctl.commands.length).toBeGreaterThanOrEqual(1);
  const sent = ctl.commands[0];
  expect(sent.authorization).toBe("Bearer " + ctl.session.token);
  expect(sent.url).toBe("/v1/session/" + ctl.session.id + "/commands");
  assertCommand(sent.body, ctl.session.id);
  expect(sent.body.type).toBe("answer");
  expect(sent.body.question_id).toBe("q-cta");
  expect(sent.body.option_id).toBe("describe");
  expect(sent.body.answer_source).toBe("tap");
  expect(sent.body.expected_version).toBe(1);
  const events = ctl.requests.filter((req) => req.method === "GET" && req.url.includes("/events"));
  expect(events.length).toBeGreaterThanOrEqual(1);
  expect(events[0].authorization).toBe("Bearer " + ctl.session.token);
  expect(events[0].lastEventId).toBe("");
  assertClean(urls);
});

test("a dropped stream reconnects with Last-Event-ID and loses nothing", async ({ page }) => {
  const urls = await openStudio(page);
  ctl.armDrop(1);
  await answer(page);
  await expect.poll(() => ctl.droppedAt !== "" && ctl.resumes.length === 1 && ctl.resumes[0] === ctl.droppedAt, {
    timeout: 10000
  }).toBe(true);
  await expect(page.locator("#studio-artifact")).toHaveAttribute("data-artifact-version", "2", { timeout: 10000 });
  await expect(page.locator('[data-node-id="hero-cta"]')).toContainText("Describe a problem");
  await expect(page.locator("[data-studio-confirm]")).toHaveText(
    "Using Describe a problem. The hero action now opens guided intake.");
  await expect(page.locator("body")).not.toContainText("STALE");
  const dropped = ctl.session.events.find((event) => String(event.seq) === ctl.droppedAt);
  expect(dropped.type).toBe("progress");
  const resume = ctl.requests.filter((req) => req.method === "GET" && req.lastEventId);
  expect(resume).toHaveLength(1);
  expect(resume[0].lastEventId).toBe(ctl.droppedAt);
  expect(resume[0].authorization).toBe("Bearer " + ctl.session.token);
  const gets = ctl.requests.filter((req) => req.method === "GET" && req.url.includes("/events"));
  expect(gets).toHaveLength(2);
  assertClean(urls);
});

test("a restarted controller sends generation 2 and the page adopts the snapshot", async ({ page }) => {
  const urls = await openStudio(page);
  const prior = ctl.session.events.filter((event) => event.generation === 1);
  const cursor = String(prior[prior.length - 1].seq);
  ctl.restart();
  await expect(page.locator('[data-node-id="hero-heading"]')).toContainText("Rebuilt after a restart", { timeout: 10000 });
  await expect(page.locator("#studio-artifact")).toHaveAttribute("data-artifact-version", "7");
  const snap = ctl.session.events[ctl.session.events.length - 1];
  expect(snap.generation).toBe(2);
  expect(snap.seq).toBe(1);
  expect(snap.type).toBe("artifact.snapshot");
  expect(ctl.resumes).toContain(cursor);
  await expect(page.locator("body")).not.toContainText("Your Salesforce, working");
  assertClean(urls);
});

test("a stale command shows catching up until the snapshot arrives", async ({ page }) => {
  const urls = await openStudio(page);
  ctl.desync(4);
  await answer(page);
  await expect(page.locator("[data-studio-status]")).toHaveText("Catching up");
  expect(ctl.commands).toHaveLength(1);
  expect(ctl.commands[0].status).toBe(409);
  expect(ctl.commands[0].response).toEqual({ detail: "stale expected_version" });
  expect(ctl.commands[0].response.error).toBeUndefined();
  expect(ctl.commands[0].authorization).toBe("Bearer " + ctl.session.token);
  ctl.recover();
  await expect(page.locator('[data-node-id="hero-heading"]')).toContainText("Caught up");
  await expect(page.locator("#studio-artifact")).toHaveAttribute("data-artifact-version", "4");
  await expect(page.locator("[data-studio-status]")).toBeHidden();
  assertClean(urls);
});

test("401 on the event stream returns to sign-in and does not retry", async ({ page }) => {
  ctl.failEvents = 401;
  await seedOperator(page);
  const urls = track(page);
  await page.goto(site.origin + "/studio/");
  await expect(page.locator("[data-studio-email]")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("This session has ended.");
  await expect(page.locator("[data-studio-card]")).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem("studio.operator"))).toBeNull();
  await page.waitForTimeout(4500);
  const gets = ctl.requests.filter((req) => req.method === "GET" && req.url.includes("/events"));
  const posts = ctl.requests.filter((req) => req.method === "POST" && req.url === "/v1/session");
  expect(gets).toHaveLength(1);
  expect(posts).toHaveLength(1);
  expect(gets[0].authorization).toBe("Bearer " + ctl.session.token);
  assertClean(urls);
});

test("404 ends the session and does not retry", async ({ page }) => {
  ctl.failEvents = 404;
  await seedOperator(page);
  const urls = track(page);
  await page.goto(site.origin + "/studio/");
  await expect(page.locator("[data-studio-status]")).toHaveText("This session has ended.");
  await page.waitForTimeout(4500);
  const gets = ctl.requests.filter((req) => req.method === "GET" && req.url.includes("/events"));
  expect(gets).toHaveLength(1);
  assertClean(urls);
});

async function finishRoundTrip(page) {
  await answer(page);
  await expect(page.locator("#studio-artifact")).toHaveAttribute("data-artifact-version", "2", { timeout: 10000 });
  await expect(page.locator('[data-node-id="hero-cta"]')).toContainText("Describe a problem");
  await expect(page.locator("[data-studio-confirm]")).toHaveText(
    "Using Describe a problem. The hero action now opens guided intake.");
  await expect(page.locator("[data-studio-status]")).toBeHidden();
}

test("a 429 on the event stream retries after retry_after and the round trip completes", async ({ page }) => {
  ctl.failEventsOnce = { retry_after: 1 };
  await seedOperator(page);
  const urls = track(page);
  await page.goto(site.origin + "/studio/");
  const status = page.locator("[data-studio-status]");
  await expect(status).toContainText(/the studio is busy, try again shortly/i);
  await expect(status).toContainText("Try again in 1 second.");
  await expect(page.locator('[data-studio-card][data-question-id="q-cta"]')).toBeVisible({ timeout: 10000 });
  await finishRoundTrip(page);
  const gets = ctl.requests.filter((req) => req.method === "GET" && req.url.includes("/events"));
  expect(gets.length).toBeGreaterThanOrEqual(2);
  expect(gets[0].authorization).toBe("Bearer " + ctl.session.token);
  assertClean(urls);
});

test("a 429 on session start reopens once after retry_after and the round trip completes", async ({ page }) => {
  ctl.failStartOnce = { header: 1 };
  const token = await seedOperator(page);
  const urls = track(page);
  await page.goto(site.origin + "/studio/");
  const status = page.locator("[data-studio-status]");
  await expect(status).toContainText(/the studio is busy, try again shortly/i);
  await expect(status).toContainText("Try again in 1 second.");
  await expect(page.locator('[data-studio-card][data-question-id="q-cta"]')).toBeVisible({ timeout: 10000 });
  await finishRoundTrip(page);
  const posts = ctl.requests.filter((req) => req.method === "POST" && req.url === "/v1/session");
  expect(posts).toHaveLength(2);
  expect(ctl.starts).toHaveLength(2);
  expect(ctl.starts[0].creation_id).toMatch(/^[0-9a-f]{32}$/);
  expect(ctl.starts[1].creation_id).toBe(ctl.starts[0].creation_id);
  expect(ctl.starts[0].authorization).toBe("Bearer " + token);
  expect(ctl.starts[1].authorization).toBe("Bearer " + token);
  assertClean(urls);
});

test("no request ever carries the token in the URL", async ({ page }) => {
  const urls = await openStudio(page);
  await answer(page);
  await expect(page.locator("#studio-artifact")).toHaveAttribute("data-artifact-version", "2");
  expect(ctl.session.token.length).toBeGreaterThan(16);
  assertClean(urls);
  const joined = ctl.requests.map((req) => req.url).join("\n");
  expect(joined).not.toContain(ctl.session.token);
  expect(urls.join("\n")).not.toContain(ctl.session.token);
});

test("fixture mode leaves the controller untouched", async ({ page }) => {
  const urls = track(page);
  await page.goto(site.origin + "/studio/?script=fixture");
  await expect(page.locator("#studio-artifact")).toHaveAttribute("data-artifact-version", "1");
  await expect(page.locator('[data-studio-card][data-question-id="q-cta"]')).toBeVisible();
  await expect(page.locator("[data-studio-email]")).toHaveCount(0);
  expect(ctl.requests.filter((req) => req.method !== "OPTIONS")).toEqual([]);
  expect(ctl.session).toBeNull();
  expect(urls.every((url) => url.startsWith(site.origin))).toBe(true);
});

const ALLOWED_NOTE = "If that address is allowed, a code is on its way.";

test("sign-in gives the same reply for an allowed address and an unknown one", async ({ page, browser }) => {
  const other = await browser.newContext();
  const page2 = await other.newPage();
  await page.goto(site.origin + "/studio/");
  await page2.goto(site.origin + "/studio/");
  await page.locator("[data-studio-email]").fill("Operator@SFDC24.com ");
  await page.locator("[data-studio-send-code]").click();
  await expect(page.locator("[data-studio-signin-note]")).toHaveText(ALLOWED_NOTE);
  await page2.locator("[data-studio-email]").fill("nobody@example.com");
  await page2.locator("[data-studio-send-code]").click();
  await expect(page2.locator("[data-studio-signin-note]")).toHaveText(ALLOWED_NOTE);
  expect(ctl.authStarts.map((item) => item.email)).toEqual(["operator@sfdc24.com", "nobody@example.com"]);
  expect(ctl.authStarts.every((item) => typeof item.client_key === "string" && item.client_key.length >= 32)).toBe(true);
  expect(ctl.authReplies).toHaveLength(2);
  expect(ctl.authReplies[0].expires_in).toBe(600);
  expect(Object.keys(ctl.authReplies[0]).sort()).toEqual(Object.keys(ctl.authReplies[1]).sort());
  expect(ctl.authReplies[0].challenge_id).not.toBe(ctl.authReplies[1].challenge_id);
  for (const reply of ctl.authReplies) {
    expect(reply).not.toHaveProperty("sent");
    expect(reply).not.toHaveProperty("allowed");
    expect(JSON.stringify(reply)).not.toMatch(/sent|allowed|delivered/i);
  }
  await other.close();
});

test("a wrong code is not accepted", async ({ page }) => {
  await page.goto(site.origin + "/studio/");
  await page.locator("[data-studio-email]").fill("operator@sfdc24.com");
  await page.locator("[data-studio-send-code]").click();
  await expect(page.locator("[data-studio-code]")).toBeVisible();
  await page.locator("[data-studio-code]").fill("000000");
  await page.locator("[data-studio-check-code]").click();
  await expect(page.locator("[data-studio-signin-error]")).toHaveText("That code was not accepted.");
  expect(await page.evaluate(() => sessionStorage.getItem("studio.operator"))).toBeNull();
  expect(ctl.starts).toHaveLength(0);
});

test("a correct code opens the session", async ({ page }) => {
  await page.goto(site.origin + "/studio/");
  await page.locator("[data-studio-email]").fill("operator@sfdc24.com");
  await page.locator("[data-studio-send-code]").click();
  await expect(page.locator("[data-studio-signin-note]")).toHaveText(ALLOWED_NOTE);
  await page.locator("[data-studio-code]").fill("123456");
  await page.locator("[data-studio-check-code]").click();
  await expect(page.locator('[data-studio-card][data-question-id="q-cta"]')).toBeVisible();
  const stored = JSON.parse(await page.evaluate(() => sessionStorage.getItem("studio.operator")));
  expect(stored.token.length).toBeGreaterThan(16);
  expect(ctl.operators.has(stored.token)).toBe(true);
  expect(ctl.starts).toHaveLength(1);
  expect(ctl.starts[0].authorization).toBe("Bearer " + stored.token);
  expect(ctl.starts[0].creation_id).toMatch(/^[0-9a-f]{32}$/);
  const dump = await page.evaluate(() => JSON.stringify(sessionStorage));
  expect(dump).not.toContain(ctl.authStarts[0].client_key);
});

test("a 401 on start returns to sign-in", async ({ page }) => {
  await seedOperator(page);
  ctl.failStartOnce = { status: 401 };
  await page.goto(site.origin + "/studio/");
  await expect(page.locator("[data-studio-email]")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("This session has ended.");
  expect(await page.evaluate(() => sessionStorage.getItem("studio.operator"))).toBeNull();
  const posts = ctl.requests.filter((req) => req.method === "POST" && req.url === "/v1/session");
  expect(posts).toHaveLength(1);
  expect(ctl.session).toBeNull();
});

test("an empty 200 stream backs off and ends the session", async ({ page }) => {
  ctl.emptyClose = true;
  await seedOperator(page);
  const started = Date.now();
  await page.goto(site.origin + "/studio/");
  await expect(page.locator("[data-studio-status]")).toHaveText("This session has ended.", { timeout: 20000 });
  expect(Date.now() - started).toBeLessThan(20000);
  const events = ctl.requests.filter((req) => req.method === "GET" && req.url.includes("/events"));
  expect(events.length).toBeGreaterThanOrEqual(5);
  expect(events.length).toBeLessThanOrEqual(6);
  expect(events[1].at - events[0].at).toBeGreaterThanOrEqual(500);
  const stoppedAt = events.length;
  await page.waitForTimeout(3000);
  const later = ctl.requests.filter((req) => req.method === "GET" && req.url.includes("/events"));
  expect(later.length).toBe(stoppedAt);
  await expect(page.locator("[data-studio-status]")).toHaveText("This session has ended.");
});

test("a clean stream close reconnects at once without duplicating events", async ({ page }) => {
  await openStudio(page);
  const writes = ctl.eventWrites;
  const last = ctl.session.events[ctl.session.events.length - 1];
  ctl.closeOpenStreams();
  await expect.poll(() => ctl.requests.filter((req) => req.method === "GET" && req.url.includes("/events")).length, {
    timeout: 5000
  }).toBe(2);
  const gets = ctl.requests.filter((req) => req.method === "GET" && req.url.includes("/events"));
  expect(gets[1].at - ctl.closedAt).toBeLessThan(800);
  expect(gets[1].lastEventId).toBe(String(last.seq));
  expect(gets[1].lastEventId).toMatch(/^\d+$/);
  expect(ctl.eventWrites).toBe(writes);
  await expect(page.locator('[data-studio-card][data-question-id="q-cta"]')).toHaveCount(1);
});

test("Last-Event-ID is an integer seq", async ({ page }) => {
  await openStudio(page);
  ctl.armDrop(1);
  await answer(page);
  await expect.poll(() => ctl.resumes.length === 1 && /^\d+$/.test(ctl.resumes[0]), { timeout: 10000 }).toBe(true);
  expect(ctl.resumes[0]).toBe(ctl.droppedAt);
  expect(ctl.droppedAt).not.toContain(":");
  const bad = await fetch(ctl.origin + "/v1/session/" + ctl.session.id + "/events", {
    headers: {
      authorization: "Bearer " + ctl.session.token,
      "last-event-id": "1:4"
    }
  });
  expect(bad.status).toBe(400);
  const badBody = await bad.json();
  expect(badBody.detail).toBeTruthy();
  expect(badBody.error).toBeUndefined();
});

test("an unknown 409 body still shows Catching up", async ({ page }) => {
  await openStudio(page);
  ctl.commandOverride = { status: 409, body: { detail: "not a recognized code" } };
  await answer(page);
  await expect(page.locator("[data-studio-status]")).toHaveText("Catching up");
  expect(ctl.commands).toHaveLength(1);
  expect(ctl.commands[0].status).toBe(409);
  expect(ctl.commands[0].response).toEqual({ detail: "not a recognized code" });
  expect(ctl.commands[0].response.error).toBeUndefined();
  expect(ctl.session.artifactVersion).toBe(1);
});

// Voice leg. RTCPeerConnection and getUserMedia are stubs. The voice flag
// comes from GET /v1/health, the same body the controller will serve.
async function installVoiceStub(page) {
  await page.addInitScript(() => {
    const voice = {
      mediaCalls: 0,
      constraints: [],
      connections: [],
      channels: [],
      tracks: [],
      failMedia: false
    };
    window.__voiceTest = voice;
    const getUserMedia = async (constraints) => {
      voice.mediaCalls += 1;
      voice.constraints.push(constraints);
      if (voice.failMedia) throw new DOMException("Permission denied", "NotAllowedError");
      const track = {
        kind: "audio",
        readyState: "live",
        enabled: true,
        stopped: false,
        stop() {
          this.stopped = true;
          this.readyState = "ended";
        }
      };
      voice.tracks.push(track);
      return {
        getTracks() { return [track]; },
        getAudioTracks() { return [track]; }
      };
    };
    try {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: { getUserMedia }
      });
    } catch (err) {
      navigator.mediaDevices.getUserMedia = getUserMedia;
    }
    class FakePeerConnection {
      constructor() {
        this.iceGatheringState = "complete";
        this.connectionState = "new";
        this.localDescription = null;
        this.remoteDescription = null;
        this.closed = false;
        this.ontrack = null;
        this.onicecandidate = null;
        this.added = [];
        voice.connections.push(this);
      }
      addEventListener() {}
      removeEventListener() {}
      addTrack(track, stream) {
        this.added.push({ track, hasStream: !!stream });
      }
      createDataChannel(label) {
        const channel = {
          label,
          readyState: "open",
          sent: [],
          onmessage: null,
          onopen: null,
          send(data) { this.sent.push(String(data)); },
          close() { this.readyState = "closed"; }
        };
        this.channel = channel;
        voice.channels.push(channel);
        return channel;
      }
      createOffer() {
        return Promise.resolve({ type: "offer", sdp: "v=0\r\noffer-sdp" });
      }
      setLocalDescription(desc) {
        this.localDescription = { type: desc.type, sdp: desc.sdp };
        return Promise.resolve();
      }
      setRemoteDescription(desc) {
        this.remoteDescription = { type: desc.type, sdp: desc.sdp };
        return Promise.resolve();
      }
      close() {
        this.closed = true;
        this.connectionState = "closed";
        if (this.channel && this.channel.close) this.channel.close();
      }
    }
    window.RTCPeerConnection = FakePeerConnection;
  });
}

async function openVoice(page) {
  ctl.voiceEnabled = true;
  await installVoiceStub(page);
  const urls = await openStudio(page);
  await expect(page.locator("[data-action='talk']")).toBeVisible();
  return urls;
}

async function pressTalk(page) {
  await page.locator("[data-action='talk']").click();
  await expect(page.locator("[data-studio-voice-status]")).toHaveText("Listening");
}

function voiceCommands(type) {
  return ctl.commands.filter((entry) => entry.body && entry.body.type === type);
}

test("Talk stays hidden until /v1/health says voice, and the walkthrough has none", async ({ page }) => {
  await installVoiceStub(page);
  await openStudio(page);
  await expect(page.locator("[data-action='talk']")).toBeHidden();
  expect(await page.evaluate(() => window.__voiceTest.mediaCalls)).toBe(0);
  const health = ctl.requests.filter((req) => req.url.split("?")[0] === "/v1/health");
  expect(health.length).toBeGreaterThan(0);
  expect(health[0].method).toBe("GET");
  expect(health[0].authorization).toBe("");
  expect(health.every((req) => !req.url.includes("healthz"))).toBe(true);

  ctl.voiceEnabled = true;
  ctl.healthStatus = 404;
  await page.goto(site.origin + "/studio/");
  await expect(page.locator('[data-studio-card][data-question-id="q-cta"]')).toBeVisible();
  await expect(page.locator("[data-action='talk']")).toBeHidden();

  ctl.healthStatus = 200;
  ctl.omitHealth = true;
  await page.goto(site.origin + "/studio/");
  await expect(page.locator('[data-studio-card][data-question-id="q-cta"]')).toBeVisible();
  await expect(page.locator("[data-action='talk']")).toBeHidden();
  expect(await page.evaluate(() => window.__voiceTest.mediaCalls)).toBe(0);

  await page.goto(site.origin + "/studio/?script=fixture");
  await expect(page.locator("[data-studio-demo]")).toBeVisible();
  await expect(page.locator("[data-action='talk']")).toHaveCount(0);
  expect(await page.evaluate(() => window.__voiceTest.mediaCalls)).toBe(0);
});

test("Talk posts the offer with the bearer and never puts it in a URL", async ({ page }) => {
  const urls = await openVoice(page);
  expect(await page.evaluate(() => window.__voiceTest.mediaCalls)).toBe(0);
  await pressTalk(page);
  expect(await page.evaluate(() => window.__voiceTest.mediaCalls)).toBe(1);
  expect(await page.evaluate(() => window.__voiceTest.constraints[0])).toEqual({ audio: true });
  expect(await page.evaluate(() => window.__voiceTest.channels[0].label)).toBe("oai-events");
  expect(await page.evaluate(() => window.__voiceTest.channels[0].sent)).toEqual([]);
  expect(ctl.voicePosts).toHaveLength(1);
  const post = ctl.voicePosts[0];
  expect(post.url).toBe("/v1/session/" + ctl.session.id + "/voice");
  expect(post.url.includes("?")).toBe(false);
  expect(post.authorization).toBe("Bearer " + ctl.session.token);
  expect(post.sdp).toBe("v=0\r\noffer-sdp");
  for (const req of ctl.requests) {
    expect(req.url).not.toContain("offer-sdp");
    expect(req.url).not.toContain(ctl.session.token);
  }
  for (const url of urls) {
    expect(url).not.toContain("offer-sdp");
    expect(url).not.toContain(ctl.session.token);
  }
  const remote = await page.evaluate(() => window.__voiceTest.connections[0].remoteDescription);
  expect(remote).toEqual({ type: "answer", sdp: "v=0\r\nanswer-sdp" });
  expect(await page.locator("[data-studio-voice-audio]").count()).toBe(1);
});

test("a completed transcript sends one utterance and a repeated item_id sends none", async ({ page }) => {
  await openVoice(page);
  await pressTalk(page);
  await page.evaluate(() => {
    window.__voiceTest.channels[0].onmessage({
      data: JSON.stringify({
        type: "conversation.item.input_audio_transcription.delta",
        item_id: "item-book",
        delta: "Book "
      })
    });
  });
  await expect(page.locator("[data-studio-caption]")).toHaveText("Book ");
  expect(voiceCommands("utterance")).toHaveLength(0);

  const completed = {
    type: "conversation.item.input_audio_transcription.completed",
    item_id: "item-book",
    transcript: "Book a consultation, please."
  };
  await page.evaluate((msg) => {
    window.__voiceTest.channels[0].onmessage({ data: JSON.stringify(msg) });
  }, completed);
  await expect.poll(() => voiceCommands("utterance").length).toBe(1);
  await page.evaluate((msg) => {
    window.__voiceTest.channels[0].onmessage({ data: JSON.stringify(msg) });
  }, completed);
  await page.waitForTimeout(400);
  expect(voiceCommands("utterance")).toHaveLength(1);
  const sent = voiceCommands("utterance")[0];
  expect(sent.authorization).toBe("Bearer " + ctl.session.token);
  expect(sent.url).toBe("/v1/session/" + ctl.session.id + "/commands");
  assertCommand(sent.body, ctl.session.id);
  expect(sent.body.item_id).toBe("item-book");
  expect(sent.body.transcript).toBe("Book a consultation, please.");
  expect(sent.body.expected_version).toBe(1);
  await expect(page.locator("[data-studio-caption]")).toHaveText("Book a consultation, please.");
});

test("a confirm is spoken with that text, and barge-in is not an error", async ({ page }) => {
  await openVoice(page);
  await pressTalk(page);
  await answer(page);
  const spoken = "Say this to the visitor, naturally: Using Describe a problem. The hero action now opens guided intake.";
  await expect.poll(async () => page.evaluate((line) => {
    const sent = window.__voiceTest.channels[0].sent.map((item) => JSON.parse(item));
    return sent.some((msg) => msg.type === "conversation.item.create" &&
      msg.item && msg.item.content && msg.item.content[0] && msg.item.content[0].text === line);
  }, spoken)).toBe(true);
  const sent = await page.evaluate(() => window.__voiceTest.channels[0].sent.map((item) => JSON.parse(item)));
  const at = sent.findIndex((msg) => msg.type === "conversation.item.create" &&
    msg.item.content[0].text === spoken);
  expect(sent[at]).toEqual({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: spoken }]
    }
  });
  expect(sent[at + 1]).toEqual({
    type: "response.create",
    response: { output_modalities: ["audio"] }
  });

  await page.evaluate(() => {
    const deliver = (msg) => window.__voiceTest.channels[0].onmessage({ data: JSON.stringify(msg) });
    deliver({
      type: "response.done",
      response: {
        status: "cancelled",
        status_details: { type: "cancelled", reason: "turn_detected" }
      }
    });
    deliver({ type: "response.done", status: "cancelled", reason: "turn_detected" });
  });
  await expect(page.locator("[data-studio-voice-status]")).toHaveText("Listening");
  await expect(page.locator("[data-studio-voice-status]")).not.toContainText("could not");
  expect(await page.evaluate(() => window.__voiceTest.connections[0].closed)).toBe(false);
});

test("Stop sends stop, closes the connection, stops the tracks, and hides the caption", async ({ page }) => {
  await openVoice(page);
  await pressTalk(page);
  await page.evaluate(() => {
    window.__voiceTest.channels[0].onmessage({
      data: JSON.stringify({
        type: "conversation.item.input_audio_transcription.delta",
        delta: "hello"
      })
    });
  });
  await expect(page.locator("[data-studio-caption]")).toBeVisible();
  await page.locator("[data-action='stop-voice']").click();
  await expect.poll(() => voiceCommands("stop").length).toBe(1);
  const stop = voiceCommands("stop")[0];
  assertCommand(stop.body, ctl.session.id);
  expect(stop.authorization).toBe("Bearer " + ctl.session.token);
  expect(stop.url).toBe("/v1/session/" + ctl.session.id + "/commands");
  await expect(page.locator("[data-studio-voice-status]")).toHaveText("Voice ended.");
  await expect(page.locator("[data-studio-caption]")).toBeHidden();
  expect(await page.evaluate(() => {
    const voice = window.__voiceTest;
    return voice.connections[0].closed && voice.tracks.every((track) => track.stopped);
  })).toBe(true);
});

test("ends_at and session.ended close the call without another stop", async ({ page }) => {
  ctl.voiceEndsAt = new Date(Date.now() + 1200).toISOString();
  await openVoice(page);
  await pressTalk(page);
  await expect(page.locator("[data-studio-voice-status]")).toHaveText("Voice ended.", { timeout: 5000 });
  expect(voiceCommands("stop")).toHaveLength(0);
  expect(await page.evaluate(() => {
    const voice = window.__voiceTest;
    return voice.connections[0].closed && voice.tracks.every((track) => track.stopped);
  })).toBe(true);

  ctl.voiceEndsAt = null;
  await page.goto(site.origin + "/studio/");
  await expect(page.locator('[data-studio-card][data-question-id="q-cta"]')).toBeVisible();
  await expect(page.locator("[data-action='talk']")).toBeVisible();
  await pressTalk(page);
  ctl.endSession();
  await expect(page.locator("[data-studio-voice-status]")).toHaveText("Voice ended.");
  await expect(page.locator("[data-studio-finish]")).toBeVisible();
  expect(voiceCommands("stop")).toHaveLength(0);
  expect(await page.evaluate(() => window.__voiceTest.connections[window.__voiceTest.connections.length - 1].closed)).toBe(true);
});

test("voice 409, 502, a dropped call, and a blocked microphone stay typeable", async ({ page }) => {
  ctl.voiceStatus = 409;
  await openVoice(page);
  await page.locator("[data-action='talk']").click();
  await expect(page.locator("[data-studio-voice-status]")).toHaveText("Voice is busy for this session.");
  expect(await page.evaluate(() => window.__voiceTest.connections[0].closed)).toBe(true);
  expect(await page.evaluate(() => window.__voiceTest.tracks.every((track) => track.stopped))).toBe(true);
  await expect(page.locator("[data-action='freeform']")).toBeVisible();

  ctl.voiceStatus = 502;
  await page.goto(site.origin + "/studio/");
  await expect(page.locator("[data-action='talk']")).toBeVisible();
  await page.locator("[data-action='talk']").click();
  await expect(page.locator("[data-studio-voice-status]")).toHaveText("Voice could not start. You can still type.");

  ctl.voiceStatus = 200;
  ctl.voiceDrop = true;
  await page.goto(site.origin + "/studio/");
  await expect(page.locator("[data-action='talk']")).toBeVisible();
  await page.locator("[data-action='talk']").click();
  await expect(page.locator("[data-studio-voice-status]")).toHaveText("Voice could not start. You can still type.");
  expect(ctl.voicePosts.length).toBeGreaterThan(0);
  expect(ctl.voicePosts.every((post) => post.url.indexOf("?") < 0)).toBe(true);

  ctl.voiceDrop = false;
  await page.goto(site.origin + "/studio/");
  await expect(page.locator("[data-action='talk']")).toBeVisible();
  await page.evaluate(() => { window.__voiceTest.failMedia = true; });
  await page.locator("[data-action='talk']").click();
  await expect(page.locator("[data-studio-voice-status]")).toHaveText("Microphone blocked. You can still type.");
  expect(await page.evaluate(() => window.__voiceTest.mediaCalls)).toBe(1);
  expect(await page.evaluate(() => window.__voiceTest.connections.length)).toBe(0);
});
