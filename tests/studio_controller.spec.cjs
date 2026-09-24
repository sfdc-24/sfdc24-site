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
    authVerifies: [],
    issued: [],
    heldVerifies: [],
    holdVerify: false,
    starts: [],
    eventWrites: 0,
    closedAt: 0,
    commandOverride: null,
    commandFailures: [],
    holdCommand: null,
    heldCommands: [],
    commandDelayMs: 0,
    commandDelayUsed: false,
    advanceOnCommand: false,
    emptyClose: false,
    failEventsNext: null,
    voiceEnabled: false,
    voiceStatus: 200,
    voiceCalls: [],
    voiceEndsAt: null,
    voiceDrop: false,
    armDrop(n) { this.dropBudget = n; },
    desync(version) { this.session.artifactVersion = version; },
    restart() { restart(this); },
    recover() { recover(this); },
    emit(template) {
      if (!this.session) return null;
      const event = stamp(this.session, template);
      this.session.events.push(event);
      broadcast();
      return event;
    },
    issueOperator() {
      const token = "op" + crypto.randomBytes(16).toString("hex");
      this.operators.set(token, {
        email: "operator@sfdc24.com",
        expires_at: Math.floor(Date.now() / 1000) + 8 * 60 * 60
      });
      return token;
    },
    releaseHeldVerifies() {
      const pending = this.heldVerifies.splice(0, this.heldVerifies.length);
      for (const held of pending) completeVerify(held.req, held.res, held.body, held.ok, held.challenge);
    },
    releaseHeldCommands() {
      const pending = this.heldCommands.splice(0, this.heldCommands.length);
      for (const held of pending) {
        const spec = held.spec || {};
        if (spec.destroy) {
          held.record.status = 0;
          try { held.res.destroy(); } catch (err) { /* already closed */ }
          continue;
        }
        const status = spec.status || 409;
        const body = spec.body || { detail: "conflict" };
        held.record.status = status;
        held.record.response = body;
        held.record.held = false;
        writeJson(held.req, held.res, status, body);
      }
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

  function completeVerify(req, res, body, ok, challenge) {
    if (!ok) {
      writeJson(req, res, 401, { detail: "code not accepted" });
      return;
    }
    const token = "op" + crypto.randomBytes(16).toString("hex");
    const expiresAt = Math.floor(Date.now() / 1000) + 8 * 60 * 60;
    ctl.operators.set(token, { email: challenge.email, expires_at: expiresAt });
    ctl.issued.push({ challenge_id: body.challenge_id, token, expires_at: expiresAt });
    writeJson(req, res, 200, { token, expires_at: expiresAt, scope: "operator" });
  }

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
    if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
      writeJson(req, res, 404, { detail: "not found" });
      return;
    }
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
    if (req.method === "GET" && url.pathname === "/healthz") {
      writeJson(req, res, 200, {
        ok: true,
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
      ctl.authVerifies.push({
        challenge_id: body.challenge_id,
        email: body.email,
        code: body.code,
        client_key: body.client_key,
        status: ok ? 200 : 401
      });
      if (ctl.holdVerify) {
        ctl.holdVerify = false;
        ctl.heldVerifies.push({ req, res, body, ok, challenge });
        return;
      }
      completeVerify(req, res, body, ok, challenge);
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
        expiresAt: Math.floor(Date.now() / 1000) + 30 * 60
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
      if (ctl.failEventsNext) {
        const next = ctl.failEventsNext;
        ctl.failEventsNext = null;
        writeJson(req, res, next.status || 401, next.body || { detail: "unauthorized" });
        return;
      }
      if (ctl.failEventsOnce) {
        const once = ctl.failEventsOnce;
        ctl.failEventsOnce = null;
        if (once.status && once.status !== 429) {
          writeJson(req, res, once.status, once.body || { detail: "refused" });
          return;
        }
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
      if (ctl.holdCommand) {
        const spec = ctl.holdCommand;
        ctl.holdCommand = null;
        const record = {
          body: command,
          authorization: req.headers.authorization,
          status: null,
          response: null,
          url: req.url,
          held: true
        };
        ctl.commands.push(record);
        ctl.heldCommands.push({ req, res, spec, record });
        return;
      }
      const prior = session.seen.get(command.command_id);
      if (prior) {
        ctl.commands.push({ body: command, authorization: req.headers.authorization, status: prior.status, response: prior.body, url: req.url });
        writeJson(req, res, prior.status, prior.body);
        return;
      }
      if (ctl.commandFailures.length || ctl.commandOverride) {
        const over = ctl.commandFailures.length ? ctl.commandFailures.shift() : ctl.commandOverride;
        if (!ctl.commandFailures.length && over === ctl.commandOverride) ctl.commandOverride = null;
        const status = over.status || 409;
        const body = over.body || { detail: "conflict" };
        if (over.remember !== false) session.seen.set(command.command_id, { status, body });
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
      if (ctl.advanceOnCommand) session.artifactVersion += 1;
      const body = {
        command_id: command.command_id,
        session_id: session.id,
        artifact_version: session.artifactVersion,
        events: [],
        problems: []
      };
      session.seen.set(command.command_id, { status: 200, body });
      ctl.commands.push({ body: command, authorization: req.headers.authorization, status: 200, response: body, url: req.url });
      if (ctl.commandDelayMs && !ctl.commandDelayUsed) {
        ctl.commandDelayUsed = true;
        await new Promise((resolve) => setTimeout(resolve, ctl.commandDelayMs));
      }
      writeJson(req, res, 200, body);
      broadcast();
      return;
    }

    if (req.method === "POST" && parts[3] === "voice") {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw); } catch (err) { body = {}; }
      ctl.voiceCalls.push({
        authorization: req.headers.authorization || "",
        url: req.url,
        body
      });
      if (!authed) {
        writeJson(req, res, 401, { detail: "unauthorized" });
        return;
      }
      if (ctl.voiceDrop) {
        res.destroy();
        return;
      }
      if (ctl.voiceStatus !== 200) {
        writeJson(req, res, ctl.voiceStatus, { detail: "voice refused" });
        return;
      }
      const endsAt = ctl.voiceEndsAt != null
        ? ctl.voiceEndsAt
        : Math.floor(Date.now() / 1000) + 600;
      writeJson(req, res, 200, {
        sdp: "v=0\r\nanswer-sdp\r\n",
        voice_id: "voice-test",
        ends_at: endsAt
      });
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

function assertSlashless(urls) {
  for (const url of urls) {
    if (!url.startsWith(ctl.origin)) continue;
    const path = new URL(url).pathname;
    expect(path.endsWith("/"), path).toBe(false);
  }
}

function assertClean(urls) {
  const token = ctl.session && ctl.session.token;
  assertTokenNotInUrls(urls, token);
  assertTokenNotInUrls(ctl.requests.map((req) => new URL(req.url, ctl.origin).href), token);
  assertSlashless(urls);
  assertSlashless(ctl.requests.map((req) => new URL(req.url, ctl.origin).href));
}

async function seedOperator(page) {
  const token = ctl.issueOperator();
  const stored = JSON.stringify({
    token,
    expires_at: Math.floor(Date.now() / 1000) + 8 * 60 * 60
  });
  await page.addInitScript((value) => {
    sessionStorage.setItem("studio.operator", value);
  }, stored);
  return token;
}

async function openStudio(page, search) {
  await seedOperator(page);
  const urls = track(page);
  const extra = search ? String(search).replace(/^\?/, "") : "";
  await page.goto(site.origin + "/studio/?live=1" + (extra ? "&" + extra : ""));
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
  await expect(page.locator("[data-studio-status]")).toBeHidden();
  await expect.poll(() => ctl.commands.length).toBe(2);
  expect(ctl.commands[1].status).toBe(200);
  expect(ctl.commands[1].body.expected_version).toBe(4);
  expect(ctl.commands[1].body.command_id).not.toBe(ctl.commands[0].body.command_id);
  assertClean(urls);
});

test("a 409 followed by a newer patch hides Catching up", async ({ page }) => {
  await openStudio(page);
  ctl.commandOverride = { status: 409, body: { error: "stale_version", current_version: 2 } };
  await answer(page);
  await expect(page.locator("[data-studio-status]")).toHaveText("Catching up");
  ctl.emit({
    type: "artifact.patch",
    task_id: "t-home",
    task_revision: ctl.session.taskRevision || 1,
    turn_id: "turn-patch",
    payload: {
      ops: [{ op: "set_label", node_id: "hero-heading", value: "Patched while catching up" }]
    }
  });
  await expect(page.locator("[data-studio-status]")).toBeHidden();
  await expect(page.locator('[data-node-id="hero-heading"]')).toContainText("Patched while catching up");
});

test("session.ended clears Catching up", async ({ page }) => {
  await openStudio(page);
  ctl.commandOverride = { status: 409, body: { detail: "stale expected_version" } };
  await answer(page);
  await expect(page.locator("[data-studio-status]")).toHaveText("Catching up");
  ctl.emit({
    type: "session.ended",
    task_id: "t-home",
    task_revision: ctl.session.taskRevision || 1,
    artifact_version: ctl.session.artifactVersion,
    turn_id: "turn-end",
    payload: { reason: "Time is up." }
  });
  await expect(page.locator("[data-studio-finish]")).toBeVisible();
  await expect(page.locator("[data-studio-status]")).not.toHaveText("Catching up");
  await page.waitForTimeout(400);
  expect(ctl.commands).toHaveLength(1);
});

test("401 on the event stream returns to sign-in and does not retry", async ({ page }) => {
  ctl.failEvents = 401;
  await seedOperator(page);
  const urls = track(page);
  await page.goto(site.origin + "/studio/?live=1");
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
  await page.goto(site.origin + "/studio/?live=1");
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
  await page.goto(site.origin + "/studio/?live=1");
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
  await page.goto(site.origin + "/studio/?live=1");
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
  await expect(page.locator("[data-studio-talk]")).toBeHidden();
  expect(ctl.requests.filter((req) => req.method !== "OPTIONS")).toEqual([]);
  expect(ctl.session).toBeNull();
  expect(urls.every((url) => url.startsWith(site.origin))).toBe(true);
});

test("the bare URL plays the walkthrough and does not call the controller", async ({ page }) => {
  const urls = track(page);
  await page.goto(site.origin + "/studio/");
  await expect(page.locator("[data-studio-demo]")).toBeVisible();
  await expect(page.locator("[data-studio-demo]")).toContainText("scripted walkthrough");
  await expect(page.locator('[data-studio-card][data-question-id="q-cta"]')).toBeVisible();
  await expect(page.locator("[data-studio-email]")).toHaveCount(0);
  const live = page.locator("[data-studio-live]");
  await expect(live).toBeVisible();
  await expect(live).toHaveText("Sign in for a live session");
  await expect(live).toHaveAttribute("href", "/studio/?live=1");
  expect(await page.evaluate(() => typeof window.__studio)).toBe("undefined");
  expect(ctl.requests.filter((req) => req.method !== "OPTIONS")).toEqual([]);
  expect(ctl.session).toBeNull();
  expect(urls.every((url) => url.startsWith(site.origin))).toBe(true);
  await live.click();
  await expect(page).toHaveURL(/\/studio\/\?live=1$/);
  await expect(page.locator("[data-studio-email]")).toBeVisible();
  await expect(page.locator("[data-studio-demo]")).toBeHidden();
  expect(ctl.requests.filter((req) => req.method !== "OPTIONS")).toEqual([]);
});

test("?live=1 opens the sign-in form", async ({ page }) => {
  await page.goto(site.origin + "/studio/?live=1");
  await expect(page.locator("[data-studio-signin]")).toBeVisible();
  await expect(page.locator("[data-studio-email]")).toBeVisible();
  await expect(page.locator("[data-studio-demo]")).toBeHidden();
  await expect(page.locator("[data-studio-live]")).toBeHidden();
  expect(await page.evaluate(() => typeof window.__studio)).toBe("undefined");
});

const ALLOWED_NOTE = "If that address is allowed, a code is on its way.";

test("sign-in gives the same reply for an allowed address and an unknown one", async ({ page, browser }) => {
  const other = await browser.newContext();
  const page2 = await other.newPage();
  await page.goto(site.origin + "/studio/?live=1");
  await page2.goto(site.origin + "/studio/?live=1");
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
  await page.goto(site.origin + "/studio/?live=1");
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
  await page.goto(site.origin + "/studio/?live=1");
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
  await page.goto(site.origin + "/studio/?live=1");
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
  await page.goto(site.origin + "/studio/?live=1");
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

test("a JSON 409 on events backs off and the session continues", async ({ page }) => {
  ctl.failEventsOnce = { status: 409, body: { detail: "repair busy" } };
  await seedOperator(page);
  const urls = track(page);
  await page.goto(site.origin + "/studio/?live=1");
  await expect(page.locator('[data-studio-card][data-question-id="q-cta"]')).toBeVisible({ timeout: 10000 });
  const gets = ctl.requests.filter((req) => req.method === "GET" && req.url.includes("/events"));
  expect(gets.length).toBeGreaterThanOrEqual(2);
  expect(gets[1].at - gets[0].at).toBeGreaterThanOrEqual(500);
  await expect(page.locator("body")).not.toContainText("This session has ended.");
  await expect(page.locator("[data-studio-status]")).not.toHaveText("Catching up");
  await finishRoundTrip(page);
  assertClean(urls);
});

test("reauthentication starts a clean session and the answer uses it", async ({ page }) => {
  await openStudio(page);
  const oldId = ctl.session.id;
  expect(await page.locator("#studio-artifact").getAttribute("data-artifact-version")).not.toBe("0");
  ctl.failEventsNext = { status: 401, body: { detail: "unauthorized" } };
  ctl.closeOpenStreams();
  await expect(page.locator("[data-studio-email]")).toBeVisible();
  await expect(page.locator("[data-studio-card]")).toHaveCount(0);
  await expect(page.locator("#studio-artifact")).toHaveAttribute("data-artifact-version", "0");
  expect(await page.evaluate(() => sessionStorage.getItem("studio.operator"))).toBeNull();
  await page.locator("[data-studio-email]").fill("operator@sfdc24.com");
  await page.locator("[data-studio-send-code]").click();
  await expect(page.locator("[data-studio-signin-note]")).toHaveText(ALLOWED_NOTE);
  await page.locator("[data-studio-code]").fill("123456");
  await page.locator("[data-studio-check-code]").click();
  await expect(page.locator('[data-studio-card][data-question-id="q-cta"]')).toBeVisible();
  const newId = ctl.session.id;
  expect(newId).not.toBe(oldId);
  await answer(page);
  await expect(page.locator("#studio-artifact")).toHaveAttribute("data-artifact-version", "2");
  expect(ctl.commands).toHaveLength(1);
  expect(ctl.commands[0].url).toBe("/v1/session/" + newId + "/commands");
  expect(ctl.commands[0].body.session_id).toBe(newId);
  expect(ctl.commands[0].url).not.toContain(oldId);
  expect(ctl.commands[0].body.session_id).not.toBe(oldId);
});

test("Send code starts a new challenge for a corrected address", async ({ page }) => {
  await page.goto(site.origin + "/studio/?live=1");
  await page.locator("[data-studio-email]").fill("typo@sfdc24.com");
  await page.locator("[data-studio-send-code]").click();
  await expect(page.locator("[data-studio-code]")).toBeVisible();
  await page.locator("[data-studio-code]").fill("111111");
  await page.locator("[data-studio-email]").fill("operator@sfdc24.com");
  await page.locator("[data-studio-send-code]").click();
  await expect.poll(() => ctl.authStarts.length).toBe(2);
  await expect(page.locator("[data-studio-code]")).toHaveValue("");
  expect(ctl.authVerifies).toHaveLength(0);
  expect(ctl.authStarts[0].email).toBe("typo@sfdc24.com");
  expect(ctl.authStarts[1].email).toBe("operator@sfdc24.com");
  expect(ctl.authStarts[1].client_key).not.toBe(ctl.authStarts[0].client_key);
  expect(ctl.authReplies[1].challenge_id).not.toBe(ctl.authReplies[0].challenge_id);
  await page.locator("[data-studio-code]").fill("123456");
  await page.locator("[data-studio-check-code]").click();
  await expect(page.locator('[data-studio-card][data-question-id="q-cta"]')).toBeVisible();
  expect(ctl.authVerifies).toHaveLength(1);
  expect(ctl.authVerifies[0].status).toBe(200);
  expect(ctl.authVerifies[0].email).toBe("operator@sfdc24.com");
  expect(ctl.authVerifies[0].challenge_id).toBe(ctl.authReplies[1].challenge_id);
  expect(ctl.authVerifies[0].client_key).toBe(ctl.authStarts[1].client_key);
});

test("Send code resends a lost code as a new challenge", async ({ page }) => {
  await page.goto(site.origin + "/studio/?live=1");
  await page.locator("[data-studio-email]").fill("operator@sfdc24.com");
  await page.locator("[data-studio-send-code]").click();
  await expect(page.locator("[data-studio-code]")).toBeVisible();
  await page.locator("[data-studio-code]").fill("000000");
  await page.locator("[data-studio-send-code]").click();
  await expect.poll(() => ctl.authStarts.length).toBe(2);
  expect(ctl.authVerifies).toHaveLength(0);
  expect(ctl.authStarts[1].email).toBe("operator@sfdc24.com");
  expect(ctl.authStarts[1].client_key).not.toBe(ctl.authStarts[0].client_key);
  expect(ctl.authReplies[1].challenge_id).not.toBe(ctl.authReplies[0].challenge_id);
  await expect(page.locator("[data-studio-code]")).toHaveValue("");
  await page.locator("[data-studio-code]").fill("123456");
  await page.locator("[data-studio-check-code]").click();
  await expect(page.locator('[data-studio-card][data-question-id="q-cta"]')).toBeVisible();
  expect(ctl.authVerifies).toHaveLength(1);
  expect(ctl.authVerifies[0].challenge_id).toBe(ctl.authReplies[1].challenge_id);
  expect(ctl.authVerifies[0].client_key).toBe(ctl.authStarts[1].client_key);
  const stored = JSON.parse(await page.evaluate(() => sessionStorage.getItem("studio.operator")));
  expect(typeof stored.expires_at).toBe("number");
  expect(stored.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
});

test("an expired epoch-seconds operator token is dropped", async ({ page }) => {
  const token = ctl.issueOperator();
  await page.addInitScript((value) => {
    sessionStorage.setItem("studio.operator", value);
  }, JSON.stringify({ token, expires_at: Math.floor(Date.now() / 1000) - 60 }));
  await page.goto(site.origin + "/studio/?live=1");
  await expect(page.locator("[data-studio-email]")).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("studio.operator"))).toBeNull();
  const posts = ctl.requests.filter((req) => req.method === "POST" && req.url === "/v1/session");
  expect(posts).toHaveLength(0);
});

async function startCode(page, email) {
  await page.locator("[data-studio-email]").fill(email);
  await page.locator("[data-studio-send-code]").click();
  await expect(page.locator("[data-studio-code]")).toBeVisible();
}

async function holdCheck(page, code) {
  ctl.holdVerify = true;
  await page.locator("[data-studio-code]").fill(code);
  await page.locator("[data-studio-check-code]").click();
  await expect.poll(() => ctl.heldVerifies.length).toBe(1);
}

async function replaceChallenge(page) {
  await page.locator("[data-studio-email]").fill("Operator@SFDC24.com ");
  await page.locator("[data-studio-send-code]").click();
  await expect.poll(() => ctl.authStarts.length).toBe(2);
  await expect(page.locator("[data-studio-code]")).toHaveValue("");
}

test("a stale verify success does not adopt the old token", async ({ page }) => {
  await page.goto(site.origin + "/studio/?live=1");
  await startCode(page, "operator@sfdc24.com");
  await holdCheck(page, "123456");
  const challengeA = ctl.authReplies[0].challenge_id;
  await replaceChallenge(page);
  const startsBefore = ctl.starts.length;
  ctl.releaseHeldVerifies();
  await page.waitForTimeout(400);
  expect(ctl.issued.map((item) => item.challenge_id)).toEqual([challengeA]);
  expect(ctl.starts).toHaveLength(startsBefore);
  expect(await page.evaluate(() => sessionStorage.getItem("studio.operator"))).toBeNull();
  await expect(page.locator("[data-studio-signin]")).toBeVisible();
  await expect(page.locator("[data-studio-email]")).toBeVisible();
  await expect(page.locator("[data-studio-code]")).toBeVisible();
  await expect(page.locator("[data-studio-signin-error]")).toBeHidden();
  await page.locator("[data-studio-code]").fill("123456");
  await page.locator("[data-studio-check-code]").click();
  await expect(page.locator('[data-studio-card][data-question-id="q-cta"]')).toBeVisible();
  const stored = JSON.parse(await page.evaluate(() => sessionStorage.getItem("studio.operator")));
  const challengeB = ctl.authReplies[1].challenge_id;
  const issuedB = ctl.issued.find((item) => item.challenge_id === challengeB);
  expect(issuedB).toBeTruthy();
  expect(stored.token).toBe(issuedB.token);
  expect(stored.token).not.toBe(ctl.issued.find((item) => item.challenge_id === challengeA).token);
  expect(ctl.starts).toHaveLength(1);
  expect(ctl.starts[0].authorization).toBe("Bearer " + stored.token);
  const verifiedB = ctl.authVerifies[ctl.authVerifies.length - 1];
  expect(verifiedB.status).toBe(200);
  expect(verifiedB.email).toBe("operator@sfdc24.com");
  expect(verifiedB.challenge_id).toBe(challengeB);
  expect(verifiedB.client_key).toBe(ctl.authStarts[1].client_key);
  await expect(page.locator("[data-studio-signin]")).toBeHidden();
});

test("a stale verify error does not change sign-in", async ({ page }) => {
  await page.goto(site.origin + "/studio/?live=1");
  await startCode(page, "operator@sfdc24.com");
  await holdCheck(page, "000000");
  await replaceChallenge(page);
  ctl.releaseHeldVerifies();
  await page.waitForTimeout(400);
  expect(ctl.issued).toHaveLength(0);
  expect(ctl.starts).toHaveLength(0);
  expect(await page.evaluate(() => sessionStorage.getItem("studio.operator"))).toBeNull();
  await expect(page.locator("[data-studio-signin]")).toBeVisible();
  await expect(page.locator("[data-studio-code]")).toBeVisible();
  await expect(page.locator("[data-studio-signin-error]")).toBeHidden();
  await expect(page.locator("body")).not.toContainText("That code was not accepted.");
  await expect(page.locator("body")).not.toContainText("The studio could not be reached.");
  await page.locator("[data-studio-code]").fill("123456");
  await page.locator("[data-studio-check-code]").click();
  await expect(page.locator('[data-studio-card][data-question-id="q-cta"]')).toBeVisible();
  const stored = JSON.parse(await page.evaluate(() => sessionStorage.getItem("studio.operator")));
  expect(stored.token).toBe(ctl.issued[0].token);
  expect(ctl.authVerifies[ctl.authVerifies.length - 1].challenge_id).toBe(ctl.authReplies[1].challenge_id);
  expect(ctl.authVerifies[ctl.authVerifies.length - 1].client_key).toBe(ctl.authStarts[1].client_key);
  expect(ctl.starts).toHaveLength(1);
});

test("a 409 that arrives after a newer patch does not stick on Catching up", async ({ page }) => {
  await openStudio(page);
  ctl.holdCommand = { status: 409, body: { detail: "stale expected_version" } };
  await answer(page);
  await expect.poll(() => ctl.heldCommands.length).toBe(1);
  expect(ctl.commands[0].body.expected_version).toBe(1);
  ctl.emit({
    type: "artifact.patch",
    task_id: "t-home",
    task_revision: ctl.session.taskRevision || 1,
    turn_id: "turn-ahead",
    payload: {
      ops: [{ op: "set_label", node_id: "hero-heading", value: "Already at version 2" }]
    }
  });
  await expect(page.locator("#studio-artifact")).toHaveAttribute("data-artifact-version", "2");
  ctl.releaseHeldCommands();
  await expect(page.locator("[data-studio-status]")).not.toHaveText("Catching up");
  await expect.poll(() => ctl.commands.length).toBe(2);
  expect(ctl.commands[0].status).toBe(409);
  expect(ctl.commands[0].response).toEqual({ detail: "stale expected_version" });
  expect(ctl.commands[1].status).toBe(200);
  expect(ctl.commands[1].body.expected_version).toBe(2);
  expect(ctl.commands[1].body.command_id).not.toBe(ctl.commands[0].body.command_id);
  await expect(page.locator('[data-node-id="hero-heading"]')).toContainText("Already at version 2");
});

test("a 409 naming the current version still waits for a newer one", async ({ page }) => {
  await openStudio(page);
  ctl.commandOverride = { status: 409, body: { detail: "stale expected_version", current_version: 1 } };
  await answer(page);
  await expect(page.locator("[data-studio-status]")).toHaveText("Catching up");
  expect(ctl.commands).toHaveLength(1);
  ctl.emit({
    type: "progress",
    task_id: "t-home",
    task_revision: ctl.session.taskRevision || 1,
    turn_id: "turn-same",
    artifact_version: 1,
    payload: { artifact_ids: ["hero-cta"], text: "Still on this version" }
  });
  await expect(page.locator("body")).toContainText("Still on this version");
  await page.waitForTimeout(400);
  expect(ctl.commands).toHaveLength(1);
  await expect(page.locator("[data-studio-status]")).toHaveText("Catching up");
  ctl.emit({
    type: "artifact.patch",
    task_id: "t-home",
    task_revision: ctl.session.taskRevision || 1,
    turn_id: "turn-newer",
    payload: {
      ops: [{ op: "set_label", node_id: "hero-heading", value: "Newer than the failure" }]
    }
  });
  await expect.poll(() => ctl.commands.length).toBe(2);
  expect(ctl.commands[1].status).toBe(200);
  expect(ctl.commands[1].body.expected_version).toBe(2);
  expect(ctl.commands[1].body.command_id).not.toBe(ctl.commands[0].body.command_id);
  await expect(page.locator("[data-studio-status]")).toBeHidden();
});

test("a named catch-up target waits for that target, not only the next version", async ({ page }) => {
  await openStudio(page);
  ctl.commandOverride = { status: 409, body: { detail: "stale expected_version", current_version: 4 } };
  await answer(page);
  await expect(page.locator("[data-studio-status]")).toHaveText("Catching up");
  const patch = (turn, label) => ({
    type: "artifact.patch",
    task_id: "t-home",
    task_revision: ctl.session.taskRevision || 1,
    turn_id: turn,
    payload: { ops: [{ op: "set_label", node_id: "hero-heading", value: label }] }
  });
  ctl.emit(patch("turn-v2", "At version 2"));
  await expect(page.locator("#studio-artifact")).toHaveAttribute("data-artifact-version", "2");
  await page.waitForTimeout(400);
  expect(ctl.commands).toHaveLength(1);
  await expect(page.locator("[data-studio-status]")).toHaveText("Catching up");
  ctl.emit(patch("turn-v3", "At version 3"));
  await expect(page.locator("#studio-artifact")).toHaveAttribute("data-artifact-version", "3");
  await page.waitForTimeout(200);
  expect(ctl.commands).toHaveLength(1);
  ctl.emit(patch("turn-v4", "At version 4"));
  await expect.poll(() => ctl.commands.length).toBe(2);
  expect(ctl.commands[1].status).toBe(200);
  expect(ctl.commands[1].body.expected_version).toBe(4);
  expect(ctl.commands[1].body.command_id).not.toBe(ctl.commands[0].body.command_id);
  await expect(page.locator("[data-studio-status]")).toBeHidden();
});

test("an ambiguous retry preserves the exact command payload", async ({ page }) => {
  await openStudio(page);
  ctl.holdCommand = { destroy: true };
  await answer(page);
  await expect.poll(() => ctl.heldCommands.length).toBe(1);
  const first = JSON.parse(JSON.stringify(ctl.commands[0].body));
  ctl.emit({
    type: "artifact.patch",
    task_id: "t-home",
    task_revision: ctl.session.taskRevision || 1,
    turn_id: "turn-after-unknown-outcome",
    payload: { ops: [{ op: "set_label", node_id: "hero-heading", value: "Advanced while response was lost" }] }
  });
  await expect(page.locator("#studio-artifact")).toHaveAttribute("data-artifact-version", "2");
  ctl.releaseHeldCommands();
  await expect.poll(() => ctl.commands.length >= 2).toBe(true);
  expect(ctl.commands[1].body).toEqual(first);
  expect(ctl.commands[1].body.command_id).toBe(ctl.commands[0].body.command_id);
  expect(ctl.commands[1].body.expected_version).toBe(1);
});

test("a permanent refusal waits for an explicit retry and keeps the payload", async ({ page }) => {
  await openStudio(page);
  ctl.holdCommand = { status: 403, body: { detail: "refused" } };
  await answer(page);
  await expect.poll(() => ctl.heldCommands.length).toBe(1);
  const first = JSON.parse(JSON.stringify(ctl.commands[0].body));
  await page.locator('[data-studio-card][data-question-id="q-cta"]')
    .getByRole("button", { name: "Decide later" }).click();
  ctl.releaseHeldCommands();
  await expect(page.locator("[data-studio-status]")).toHaveText("This action was refused.");
  await expect(page.locator("[data-studio-command-retry]")).toBeVisible();
  await page.waitForTimeout(1600);
  expect(ctl.commands).toHaveLength(1);
  await page.locator("[data-studio-command-retry]").click();
  await expect.poll(() => ctl.commands.length).toBe(3);
  expect(ctl.commands[1].body).toEqual(first);
  expect(ctl.commands[1].status).toBe(200);
  expect(ctl.commands[2].body.type).toBe("decide_later");
  await expect(page.locator("[data-studio-command-retry]")).toBeHidden();
});

test("transient failures have a finite automatic retry budget", async ({ page }) => {
  await openStudio(page);
  ctl.commandFailures = [
    { status: 500, body: { detail: "one" }, remember: false },
    { status: 500, body: { detail: "two" }, remember: false },
    { status: 500, body: { detail: "three" }, remember: false }
  ];
  await answer(page);
  await expect.poll(() => ctl.commands.length, { timeout: 6000 }).toBe(3);
  await expect(page.locator("[data-studio-command-retry]")).toBeVisible();
  const bodies = ctl.commands.map((entry) => entry.body);
  expect(bodies[1]).toEqual(bodies[0]);
  expect(bodies[2]).toEqual(bodies[0]);
  await page.waitForTimeout(1800);
  expect(ctl.commands).toHaveLength(3);
  await page.locator("[data-studio-command-retry]").click();
  await expect.poll(() => ctl.commands.length).toBe(4);
  expect(ctl.commands[3].body).toEqual(bodies[0]);
  expect(ctl.commands[3].status).toBe(200);
  await expect(page.locator("[data-studio-command-retry]")).toBeHidden();
});

test("a failed command stays in front of the queue and keeps its command id", async ({ page }) => {
  await openStudio(page);
  ctl.holdCommand = { status: 500, body: { detail: "unavailable" } };
  await answer(page);
  await expect.poll(() => ctl.heldCommands.length).toBe(1);
  const commandId = ctl.commands[0].body.command_id;
  await page.locator('[data-studio-card][data-question-id="q-cta"]')
    .getByRole("button", { name: "Decide later" }).click();
  await page.waitForTimeout(200);
  expect(ctl.commands).toHaveLength(1);
  ctl.releaseHeldCommands();
  await expect(page.locator("[data-studio-status]")).toHaveText("The studio could not be reached.");
  await page.waitForTimeout(400);
  expect(ctl.commands.filter((command) => command.body.type === "answer")).toHaveLength(1);
  expect(ctl.commands.filter((command) => command.body.type === "decide_later")).toHaveLength(0);
  await expect.poll(() => ctl.commands.filter((command) => command.body.type === "answer").length).toBe(2);
  const answers = ctl.commands.filter((command) => command.body.type === "answer");
  expect(answers[0].status).toBe(500);
  expect(answers[1].status).toBe(200);
  expect(answers[1].body.command_id).toBe(commandId);
  expect(answers[1].body.command_id).toBe(answers[0].body.command_id);
  await expect.poll(() => ctl.commands.some((command) => command.body.type === "decide_later")).toBe(true);
  const later = ctl.commands.find((command) => command.body.type === "decide_later");
  expect(ctl.commands.indexOf(later)).toBeGreaterThan(ctl.commands.indexOf(answers[1]));
  await expect(page.locator("[data-studio-status]")).not.toHaveText("The studio could not be reached.");
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

async function installVoiceStub(page) {
  await page.addInitScript(() => {
    const stub = {
      calls: [],
      sent: [],
      conns: [],
      gumCount: 0,
      closed: 0,
      stoppedTracks: 0,
      block: false,
      emit(payload) {
        const conn = stub.conns[stub.conns.length - 1];
        if (!conn || !conn.channel || typeof conn.channel.onmessage !== "function") return;
        conn.channel.onmessage({ data: JSON.stringify(payload) });
      }
    };
    window.__voiceStub = stub;
    const media = navigator.mediaDevices || {};
    if (!navigator.mediaDevices) navigator.mediaDevices = media;
    media.getUserMedia = function (constraints) {
      stub.gumCount += 1;
      stub.calls.push(constraints);
      if (stub.block) return Promise.reject(new Error("NotAllowedError"));
      const track = {
        kind: "audio",
        enabled: true,
        stop() {
          stub.stoppedTracks += 1;
          this.enabled = false;
        }
      };
      return Promise.resolve({
        getTracks() { return [track]; },
        getAudioTracks() { return [track]; }
      });
    };
    class FakePC {
      constructor() {
        this.localDescription = null;
        this.remoteDescription = null;
        this.ontrack = null;
        this.channel = null;
        stub.conns.push(this);
      }
      addTrack(track, stream) {
        this.track = track;
        this.stream = stream;
      }
      createDataChannel(name) {
        const channel = {
          label: name,
          readyState: "open",
          onmessage: null,
          onopen: null,
          send(data) { stub.sent.push(String(data)); }
        };
        this.channel = channel;
        queueMicrotask(() => {
          if (typeof channel.onopen === "function") channel.onopen();
        });
        return channel;
      }
      createOffer() {
        return Promise.resolve({ type: "offer", sdp: "v=0\r\noffer-sdp\r\n" });
      }
      setLocalDescription(desc) {
        this.localDescription = desc;
        return Promise.resolve();
      }
      setRemoteDescription(desc) {
        this.remoteDescription = desc;
        return Promise.resolve();
      }
      close() {
        stub.closed += 1;
        if (this.channel) this.channel.readyState = "closed";
      }
    }
    Object.defineProperty(window, "RTCPeerConnection", {
      configurable: true,
      writable: true,
      value: FakePC
    });
  });
}

async function openVoice(page) {
  ctl.voiceEnabled = true;
  await installVoiceStub(page);
  await openStudio(page);
  await expect(page.locator("[data-studio-talk]")).toBeVisible();
  expect(await page.evaluate(() => window.__voiceStub.gumCount)).toBe(0);
  expect(await page.evaluate(() => window.__voiceStub.conns.length)).toBe(0);
  await page.locator("[data-studio-talk]").click();
  await expect(page.locator("[data-studio-voice-status]")).toHaveText("Listening");
  await expect.poll(() => ctl.voiceCalls.length).toBe(1);
}

const CONFIRM_TEXT = "Using Describe a problem. The hero action now opens guided intake.";

test("Talk stays hidden unless the controller enables voice", async ({ page }) => {
  await openStudio(page);
  await expect(page.locator("[data-studio-talk]")).toBeHidden();
  await expect(page.locator("[data-studio-stop]")).toBeHidden();
  const health = ctl.requests.filter((req) => req.method === "GET" && req.url === "/healthz");
  expect(health.length).toBeGreaterThanOrEqual(1);
  expect(health[0].authorization).toBe("");
  expect(health[0].url).not.toContain("token");
});

test("Talk does not touch the microphone until it is pressed, and posts the offer with the bearer", async ({ page }) => {
  ctl.voiceEnabled = true;
  await installVoiceStub(page);
  const urls = await openStudio(page);
  await expect(page.locator("[data-studio-talk]")).toBeVisible();
  expect(await page.evaluate(() => window.__voiceStub.gumCount)).toBe(0);
  expect(await page.evaluate(() => window.__voiceStub.conns.length)).toBe(0);
  await page.locator("[data-studio-talk]").click();
  await expect(page.locator("[data-studio-voice-status]")).toHaveText("Listening");
  await expect.poll(() => ctl.voiceCalls.length).toBe(1);
  const call = ctl.voiceCalls[0];
  expect(call.authorization).toBe("Bearer " + ctl.session.token);
  expect(call.url).toBe("/v1/session/" + ctl.session.id + "/voice");
  expect(call.url).not.toContain("?");
  expect(call.url).not.toContain(ctl.session.token);
  expect(call.url).not.toContain("sdp");
  expect(call.body).toEqual({ sdp: "v=0\r\noffer-sdp\r\n" });
  expect(await page.evaluate(() => window.__voiceStub.calls[0])).toEqual({ audio: true });
  expect(await page.evaluate(() => window.__voiceStub.conns[0].channel.label)).toBe("oai-events");
  await expect.poll(() => page.evaluate(() => {
    const pc = window.__voiceStub.conns[0];
    return pc && pc.remoteDescription;
  })).toEqual({ type: "answer", sdp: "v=0\r\nanswer-sdp\r\n" });
  await expect(page.locator("[data-studio-voice-audio]")).toHaveAttribute("autoplay", "");
  expect(urls.join("\n")).not.toContain(ctl.session.token);
  expect(ctl.requests.map((req) => req.url).join("\n")).not.toContain(ctl.session.token);
  expect(ctl.requests.map((req) => req.url).join("\n")).not.toContain("offer-sdp");
});

test("a completed transcription sends one utterance, and the same item_id sends none", async ({ page }) => {
  await openVoice(page);
  await page.evaluate(() => {
    window.__voiceStub.emit({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item-voice-1",
      delta: "Make the"
    });
  });
  await expect(page.locator("[data-studio-caption]")).toHaveText("Make the");
  expect(ctl.commands.filter((cmd) => cmd.body.type === "utterance")).toHaveLength(0);
  await page.evaluate(() => {
    const done = {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: "item-voice-1",
      transcript: "Make the hero warmer"
    };
    window.__voiceStub.emit(done);
    window.__voiceStub.emit(done);
  });
  await expect.poll(() => ctl.commands.filter((cmd) => cmd.body.type === "utterance").length).toBe(1);
  const utterance = ctl.commands.find((cmd) => cmd.body.type === "utterance");
  expect(utterance.authorization).toBe("Bearer " + ctl.session.token);
  expect(utterance.url).toBe("/v1/session/" + ctl.session.id + "/commands");
  assertCommand(utterance.body, ctl.session.id);
  expect(utterance.body.item_id).toBe("item-voice-1");
  expect(utterance.body.transcript).toBe("Make the hero warmer");
  expect(utterance.body.expected_version).toBe(1);
  await expect(page.locator("[data-studio-caption]")).toHaveText("Make the hero warmer");
});

test("a confirm event is spoken as the controller wrote it", async ({ page }) => {
  await openVoice(page);
  await answer(page);
  await expect.poll(async () => page.evaluate(() => (
    window.__voiceStub.sent.some((raw) => raw.includes("Using Describe a problem"))
  ))).toBe(true);
  const sent = await page.evaluate(() => window.__voiceStub.sent.map((raw) => JSON.parse(raw)));
  const text = "Say this to the visitor, naturally: " + CONFIRM_TEXT;
  const at = sent.findIndex((msg) => (
    msg.type === "conversation.item.create" &&
    msg.item &&
    msg.item.role === "user" &&
    msg.item.content &&
    msg.item.content[0] &&
    msg.item.content[0].type === "input_text" &&
    msg.item.content[0].text === text
  ));
  expect(at).toBeGreaterThanOrEqual(0);
  expect(sent[at + 1]).toEqual({
    type: "response.create",
    response: { output_modalities: ["audio"] }
  });
  const copies = sent.filter((msg) => (
    msg.type === "conversation.item.create" &&
    msg.item &&
    msg.item.content &&
    msg.item.content[0] &&
    msg.item.content[0].text === text
  ));
  expect(copies).toHaveLength(1);
});

test("Stop sends stop, closes the call, stops the microphone, and hides the caption", async ({ page }) => {
  await openVoice(page);
  await page.evaluate(() => {
    window.__voiceStub.emit({
      type: "conversation.item.input_audio_transcription.delta",
      item_id: "item-voice-2",
      delta: "still talking"
    });
  });
  await expect(page.locator("[data-studio-caption]")).toBeVisible();
  await page.locator("[data-studio-stop]").click();
  await expect(page.locator("[data-studio-caption]")).toBeHidden();
  await expect(page.locator("[data-studio-voice-status]")).toHaveText("Voice ended.");
  await expect(page.locator("[data-studio-stop]")).toBeHidden();
  await expect.poll(() => ctl.commands.filter((cmd) => cmd.body.type === "stop").length).toBe(1);
  const stop = ctl.commands.find((cmd) => cmd.body.type === "stop");
  expect(stop.authorization).toBe("Bearer " + ctl.session.token);
  assertCommand(stop.body, ctl.session.id);
  expect(stop.body.type).toBe("stop");
  expect(await page.evaluate(() => window.__voiceStub.closed)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__voiceStub.stoppedTracks)).toBeGreaterThan(0);
});

test("ends_at closes the call without another voice offer", async ({ page }) => {
  ctl.voiceEnabled = true;
  ctl.voiceEndsAt = Math.floor(Date.now() / 1000) - 1;
  await installVoiceStub(page);
  await openStudio(page);
  await page.locator("[data-studio-talk]").click();
  await expect(page.locator("[data-studio-voice-status]")).toHaveText("Voice ended.");
  expect(ctl.voiceCalls).toHaveLength(1);
  expect(ctl.commands.filter((cmd) => cmd.body.type === "stop")).toHaveLength(0);
  expect(await page.evaluate(() => window.__voiceStub.closed)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__voiceStub.stoppedTracks)).toBeGreaterThan(0);
});

test("session.ended closes the microphone", async ({ page }) => {
  await openVoice(page);
  ctl.emit({
    type: "session.ended",
    task_id: "t-home",
    task_revision: ctl.session.taskRevision || 1,
    artifact_version: ctl.session.artifactVersion,
    turn_id: "turn-end",
    payload: { reason: "Time is up." }
  });
  await expect(page.locator("[data-studio-voice-status]")).toHaveText("Voice ended.");
  await expect(page.locator("[data-studio-finish]")).toBeVisible();
  expect(ctl.commands.filter((cmd) => cmd.body.type === "stop")).toHaveLength(0);
  expect(await page.evaluate(() => window.__voiceStub.closed)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__voiceStub.stoppedTracks)).toBeGreaterThan(0);
});

test("a 409 says voice is busy for this session", async ({ page }) => {
  ctl.voiceEnabled = true;
  ctl.voiceStatus = 409;
  await installVoiceStub(page);
  await openStudio(page);
  await page.locator("[data-studio-talk]").click();
  await expect(page.locator("[data-studio-voice-status]")).toHaveText("Voice is busy for this session.");
  await expect(page.locator("[data-studio-talk]")).toBeHidden();
  expect(ctl.voiceCalls).toHaveLength(1);
  expect(await page.evaluate(() => window.__voiceStub.stoppedTracks)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__voiceStub.closed)).toBeGreaterThan(0);
});

test("a 502 says voice could not start", async ({ page }) => {
  ctl.voiceEnabled = true;
  ctl.voiceStatus = 502;
  await installVoiceStub(page);
  await openStudio(page);
  await page.locator("[data-studio-talk]").click();
  await expect(page.locator("[data-studio-voice-status]")).toHaveText("Voice could not start. You can still type.");
  await expect(page.locator("[data-studio-talk]")).toBeVisible();
  expect(await page.evaluate(() => window.__voiceStub.stoppedTracks)).toBeGreaterThan(0);
});

test("a dropped voice request says voice could not start", async ({ page }) => {
  ctl.voiceEnabled = true;
  ctl.voiceDrop = true;
  await installVoiceStub(page);
  await openStudio(page);
  await page.locator("[data-studio-talk]").click();
  await expect(page.locator("[data-studio-voice-status]")).toHaveText("Voice could not start. You can still type.");
  expect(await page.evaluate(() => window.__voiceStub.gumCount)).toBe(1);
});

test("a blocked microphone leaves typing available", async ({ page }) => {
  ctl.voiceEnabled = true;
  await installVoiceStub(page);
  await openStudio(page);
  await page.evaluate(() => { window.__voiceStub.block = true; });
  await page.locator("[data-studio-talk]").click();
  await expect(page.locator("[data-studio-voice-status]")).toHaveText("Microphone blocked. You can still type.");
  expect(ctl.voiceCalls).toHaveLength(0);
  expect(await page.evaluate(() => window.__voiceStub.gumCount)).toBe(1);
  await expect(page.locator("[data-studio-talk]")).toBeVisible();
  await expect(page.locator('[data-action="freeform"]')).toBeEnabled();
});
