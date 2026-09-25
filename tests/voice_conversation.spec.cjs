// Homepage voice module. A stubbed RTCPeerConnection and a mock controller
// stand in for the microphone and the realtime call.
const { test, expect } = require("@playwright/test");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..");
const OPERATOR = "op-homepage-test";
const SESSION_ID = "home-session-1";
const SESSION_TOKEN = "home-session-token";

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
      const origin = "http://127.0.0.1:" + server.address().port;
      resolve({
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
    "access-control-allow-headers": "authorization, content-type, accept",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-max-age": "600",
    vary: "origin"
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeJson(req, res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, Object.assign({
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store"
  }, cors(req)));
  res.end(payload);
}

function talkPayload(ctl, body) {
  const source = body && typeof body === "object" ? body : {};
  const reply = ctl.talkReply || ("Reply: " + String(source.text || ""));
  const speaker = source.agent === "openai" ? "openai" : "claude";
  const turn = Number.isInteger(ctl.talkTurn)
    ? ctl.talkTurn
    : (Number.isInteger(source.turn) ? source.turn : 0);
  return { reply, speaker, turn };
}

function startController() {
  const ctl = {
    requests: [],
    sessions: [],
    voiceCalls: [],
    talkCalls: [],
    commands: [],
    voiceEnabled: false,
    agents: null,
    voiceStatus: 200,
    talkStatus: 200,
    talkReply: "",
    talkTurn: null,
    holdTalk: false,
    heldTalks: [],
    releaseTalks() {
      const held = this.heldTalks.splice(0);
      for (const item of held) writeJson(item.req, item.res, 200, talkPayload(this, item.body));
    }
  };
  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors(req));
      res.end();
      return;
    }
    const url = new URL(req.url, "http://127.0.0.1");
    const record = {
      method: req.method,
      url: url.pathname,
      authorization: req.headers.authorization || ""
    };
    ctl.requests.push(record);
    if (req.method === "GET" && url.pathname === "/health") {
      const features = { voice: ctl.voiceEnabled === true };
      if (Array.isArray(ctl.agents)) features.agents = ctl.agents.slice();
      writeJson(req, res, 200, {
        ok: true,
        worker: "mock",
        state_backend: "memory",
        features
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/session") {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw); } catch (err) { body = {}; }
      ctl.sessions.push({ authorization: record.authorization, body });
      if (record.authorization !== "Bearer " + OPERATOR) {
        writeJson(req, res, 401, { detail: "unauthorized" });
        return;
      }
      writeJson(req, res, 200, {
        session_id: SESSION_ID,
        generation: 1,
        artifact_version: 0,
        expires_at: Math.floor(Date.now() / 1000) + 600,
        max_session_seconds: 600,
        daily_admission_number: ctl.sessions.length,
        token: SESSION_TOKEN,
        events_url: "/v1/session/" + SESSION_ID + "/events"
      });
      return;
    }
    const parts = url.pathname.split("/");
    const authed = record.authorization === "Bearer " + SESSION_TOKEN;
    if (req.method === "POST" && parts[1] === "v1" && parts[2] === "session" && parts[3] === SESSION_ID && parts[4] === "voice") {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw); } catch (err) { body = {}; }
      ctl.voiceCalls.push({ authorization: record.authorization, url: url.pathname, body, status: ctl.voiceStatus });
      if (!authed) {
        writeJson(req, res, 401, { detail: "unauthorized" });
        return;
      }
      if (ctl.voiceStatus !== 200) {
        writeJson(req, res, ctl.voiceStatus, { detail: "voice refused" });
        return;
      }
      writeJson(req, res, 200, {
        sdp: "v=0\r\nanswer-sdp\r\n",
        voice_id: "voice-home",
        ends_at: Math.floor(Date.now() / 1000) + 600
      });
      return;
    }
    if (req.method === "POST" && parts[4] === "talk") {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw); } catch (err) { body = {}; }
      const status = !authed ? 401 : ctl.talkStatus;
      ctl.talkCalls.push({ authorization: record.authorization, url: url.pathname, body, status });
      if (!authed) {
        writeJson(req, res, 401, { detail: "unauthorized" });
        return;
      }
      if (ctl.holdTalk && status === 200) {
        ctl.heldTalks.push({ req, res, body });
        return;
      }
      if (status !== 200) {
        writeJson(req, res, status, { detail: "talk refused" });
        return;
      }
      writeJson(req, res, 200, talkPayload(ctl, body));
      return;
    }
    if (req.method === "POST" && parts[4] === "commands") {
      const raw = await readBody(req);
      let body = {};
      try { body = JSON.parse(raw); } catch (err) { body = {}; }
      ctl.commands.push({ authorization: record.authorization, url: url.pathname, body });
      if (!authed) {
        writeJson(req, res, 401, { detail: "unauthorized" });
        return;
      }
      writeJson(req, res, 200, {
        command_id: body.command_id,
        session_id: SESSION_ID,
        artifact_version: 0,
        events: [],
        problems: []
      });
      return;
    }
    writeJson(req, res, 404, { detail: "missing" });
  });
  return listen(server).then((bound) => {
    ctl.origin = bound.origin;
    ctl.close = bound.close;
    return ctl;
  });
}

function harness(controllerOrigin) {
  return "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head><body>" +
    "<div id=\"voice-root\"></div>" +
    "<script src=\"/assets/voice-conversation.js\"></script>" +
    "<script>SFDC24VoiceConversation.mount(document.getElementById(\"voice-root\"), {" +
    "controllerUrl: " + JSON.stringify(controllerOrigin) + "," +
    "getOperatorToken: function () { return " + JSON.stringify(OPERATOR) + "; }" +
    "});</script></body></html>";
}

function startSite(controllerOrigin) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/voice-harness.html") {
      const html = harness(controllerOrigin);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": Buffer.byteLength(html),
        "cache-control": "no-store"
      });
      res.end(html);
      return;
    }
    const file = path.join(REPO, decodeURIComponent(url.pathname).replace(/^\/+/, ""));
    if (!file.startsWith(REPO) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end("missing");
      return;
    }
    const ext = path.extname(file);
    const type = ext === ".js" ? "text/javascript; charset=utf-8" : "application/octet-stream";
    const body = fs.readFileSync(file);
    res.writeHead(200, { "content-type": type, "content-length": body.length, "cache-control": "no-store" });
    res.end(body);
  });
  return listen(server);
}

async function installVoiceStub(page) {
  await page.addInitScript(() => {
    const stub = {
      calls: [],
      sent: [],
      conns: [],
      gumCount: 0,
      closed: 0,
      stoppedTracks: 0,
      responseCount: 0,
      responses: [],
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
        this.connectionState = "new";
        this.iceGatheringState = "complete";
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
          onclose: null,
          send(data) {
            const raw = String(data);
            stub.sent.push(raw);
            let message = null;
            try { message = JSON.parse(raw); } catch (err) { /* not json */ }
            if (!message || message.type !== "response.create") return;
            const response = {
              id: "resp-stub-" + (++stub.responseCount),
              eventId: message.event_id,
              metadata: Object.assign({}, message.response && message.response.metadata)
            };
            stub.responses.push(response);
            queueMicrotask(() => {
              if (typeof channel.onmessage !== "function") return;
              channel.onmessage({ data: JSON.stringify({
                type: "response.created",
                response: {
                  id: response.id,
                  status: "in_progress",
                  metadata: response.metadata
                }
              }) });
            });
          },
          close() { this.readyState = "closed"; }
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
      addEventListener() {}
      removeEventListener() {}
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
  await page.goto(site.origin + "/voice-harness.html");
  await expect(page.locator("[data-voice-start]")).toBeVisible();
  await expect(page.locator("[data-voice-end]")).toBeHidden();
  await page.locator("[data-voice-start]").click();
  await expect(page.locator("[data-voice-status]")).toHaveText("Listening");
  await expect(page.locator("[data-voice-end]")).toBeVisible();
  await expect(page.locator("[data-voice-start]")).toBeHidden();
  await expect.poll(() => ctl.voiceCalls.length).toBe(1);
}

async function say(page, itemId, text) {
  await page.evaluate(({ itemId, text }) => {
    window.__voiceStub.emit({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: itemId,
      transcript: text
    });
  }, { itemId, text });
}

function spokenReply(page, text) {
  return page.evaluate((line) => window.__voiceStub.sent.some((raw) => {
    const msg = JSON.parse(raw);
    return msg.type === "conversation.item.create" &&
      msg.item && msg.item.content && msg.item.content[0] &&
      msg.item.content[0].text === line;
  }), text);
}

async function finishCurrentVoiceResponse(page, status, statusDetails) {
  await page.evaluate(({ outcome, details }) => {
    const current = window.__voiceStub.responses[window.__voiceStub.responses.length - 1];
    if (!current) throw new Error("no active stub response");
    window.__voiceStub.emit({
      type: "response.done",
      response: {
        id: current.id,
        status: outcome,
        status_details: details || undefined,
        metadata: current.metadata
      }
    });
  }, { outcome: status || "completed", details: statusDetails || null });
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

test("five turns speak each reply without another click", async ({ page }) => {
  await openVoice(page);
  expect(ctl.sessions).toHaveLength(1);
  expect(ctl.sessions[0].authorization).toBe("Bearer " + OPERATOR);
  expect(ctl.sessions[0].body.title).toBe("Homepage conversation");
  expect(ctl.sessions[0].body.start).toBe("blank");
  expect(ctl.sessions[0].body.creation_id).toMatch(/^[A-Za-z0-9._:-]{1,80}$/);
  expect(ctl.voiceCalls[0].authorization).toBe("Bearer " + SESSION_TOKEN);
  expect(ctl.voiceCalls[0].body).toEqual({ sdp: "v=0\r\noffer-sdp\r\n" });
  expect(ctl.voiceCalls[0].url).toBe("/v1/session/" + SESSION_ID + "/voice");
  const lines = ["one", "two", "three", "four", "five"];
  for (let i = 0; i < lines.length; i++) {
    await say(page, "item-" + lines[i], lines[i]);
    await expect.poll(() => ctl.talkCalls.length).toBe(i + 1);
    await expect.poll(() => spokenReply(page, "Reply: " + lines[i])).toBe(true);
    if (i < lines.length - 1) await finishCurrentVoiceResponse(page, "completed");
  }
  expect(ctl.talkCalls.map((call) => call.body.turn)).toEqual([1, 2, 3, 4, 5]);
  expect(ctl.talkCalls[0].body).toEqual({
    text: "one",
    history: [],
    turn: 1,
    agent: "claude"
  });
  const fifth = ctl.talkCalls[4].body;
  expect(fifth.text).toBe("five");
  expect(fifth.history).toHaveLength(8);
  expect(fifth.history[0]).toEqual({ who: "you", text: "one" });
  expect(fifth.history[7]).toEqual({ who: "claude", text: "Reply: four" });
  expect(fifth.history.map((row) => row.who)).toEqual([
    "you", "claude", "you", "claude", "you", "claude", "you", "claude"
  ]);
  const sent = await page.evaluate(() => window.__voiceStub.sent.map((raw) => JSON.parse(raw)));
  const at = sent.findIndex((msg) => (
    msg.type === "conversation.item.create" &&
    msg.item.content[0].text === "Reply: one"
  ));
  expect(sent[at + 1].type).toBe("response.create");
  expect(sent[at + 1].response.output_modalities).toEqual(["audio"]);
  expect(ctl.voiceCalls).toHaveLength(1);
  expect(ctl.commands.filter((cmd) => cmd.body && cmd.body.type === "stop")).toHaveLength(0);
  expect(await page.evaluate(() => window.__voiceStub.gumCount)).toBe(1);
  expect(await page.evaluate(() => window.__voiceStub.closed)).toBe(0);
  await expect(page.locator("[data-voice-caption]")).toBeHidden();
  await expect(page.locator("[data-voice-agent]")).toBeHidden();
});

test("barge-in cancels the active line and drops lines queued before the turn", async ({ page }) => {
  await openVoice(page);
  await say(page, "item-a", "Say the first line");
  await expect.poll(() => spokenReply(page, "Reply: Say the first line")).toBe(true);
  await say(page, "item-b", "Say the second line");
  await expect.poll(() => ctl.talkCalls.length).toBe(2);
  await page.waitForTimeout(150);
  expect(await spokenReply(page, "Reply: Say the second line")).toBe(false);
  await page.evaluate(() => window.__voiceStub.emit({ type: "input_audio_buffer.speech_started" }));
  await expect.poll(() => page.evaluate(() => (
    window.__voiceStub.sent.some((raw) => JSON.parse(raw).type === "response.cancel")
  ))).toBe(true);
  await finishCurrentVoiceResponse(page, "cancelled", { type: "cancelled", reason: "turn_detected" });
  await page.waitForTimeout(150);
  expect(await spokenReply(page, "Reply: Say the second line")).toBe(false);
  expect(await page.evaluate(() => window.__voiceStub.closed)).toBe(0);
  expect(await page.evaluate(() => window.__voiceStub.stoppedTracks)).toBe(0);
  await expect(page.locator("[data-voice-end]")).toBeVisible();
  await say(page, "item-c", "Say the third line");
  await expect.poll(() => spokenReply(page, "Reply: Say the third line")).toBe(true);
  expect(ctl.voiceCalls).toHaveLength(1);
  expect(await page.evaluate(() => window.__voiceStub.gumCount)).toBe(1);
});

test("a reply from an earlier turn is not spoken", async ({ page }) => {
  ctl.holdTalk = true;
  await openVoice(page);
  await say(page, "item-slow", "Say this slowly");
  await expect.poll(() => ctl.heldTalks.length).toBe(1);
  expect(ctl.heldTalks[0].body.turn).toBe(1);
  await page.evaluate(() => window.__voiceStub.emit({ type: "input_audio_buffer.speech_started" }));
  ctl.holdTalk = false;
  ctl.releaseTalks();
  await page.waitForTimeout(200);
  expect(await spokenReply(page, "Reply: Say this slowly")).toBe(false);
  await say(page, "item-now", "Say the current turn");
  await expect.poll(() => spokenReply(page, "Reply: Say the current turn")).toBe(true);
  expect(ctl.talkCalls[1].body.turn).toBe(2);
  expect(ctl.voiceCalls).toHaveLength(1);
  expect(await page.evaluate(() => window.__voiceStub.closed)).toBe(0);
  await expect(page.locator("[data-voice-end]")).toBeVisible();
});

test("a talk 503 is a notice and leaves the conversation open", async ({ page }) => {
  ctl.talkStatus = 503;
  await openVoice(page);
  await say(page, "item-503", "Are you there");
  await expect.poll(() => ctl.talkCalls.length).toBe(1);
  await expect(page.locator("[data-voice-status]")).toHaveText("The agent is unavailable.");
  await expect(page.locator("[data-voice-end]")).toBeVisible();
  await expect(page.locator("[data-voice-start]")).toBeHidden();
  expect(await spokenReply(page, "Reply: Are you there")).toBe(false);
  expect(ctl.commands.filter((cmd) => cmd.body && cmd.body.type === "stop")).toHaveLength(0);
  expect(await page.evaluate(() => window.__voiceStub.closed)).toBe(0);
  expect(await page.evaluate(() => window.__voiceStub.stoppedTracks)).toBe(0);
  ctl.talkStatus = 200;
  await say(page, "item-after-503", "Try once more");
  await expect.poll(() => spokenReply(page, "Reply: Try once more")).toBe(true);
  expect(ctl.voiceCalls).toHaveLength(1);
});

test("a talk 429 is a notice with no reply and leaves the conversation open", async ({ page }) => {
  ctl.talkStatus = 429;
  await openVoice(page);
  await say(page, "item-429", "One more");
  await expect.poll(() => ctl.talkCalls.length).toBe(1);
  await expect(page.locator("[data-voice-status]")).toHaveText("The agent is unavailable.");
  expect(await spokenReply(page, "Reply: One more")).toBe(false);
  expect(await page.evaluate(() => window.__voiceStub.closed)).toBe(0);
  await expect(page.locator("[data-voice-end]")).toBeVisible();
  ctl.talkStatus = 200;
  await say(page, "item-after-429", "After the limit");
  await expect.poll(() => spokenReply(page, "Reply: After the limit")).toBe(true);
});

test("End conversation sends stop and a late reply does not reopen the call", async ({ page }) => {
  ctl.holdTalk = true;
  await openVoice(page);
  await say(page, "item-late", "Hold this reply");
  await expect.poll(() => ctl.heldTalks.length).toBe(1);
  await page.locator("[data-voice-end]").click();
  await expect(page.locator("[data-voice-status]")).toHaveText("Voice ended.");
  await expect(page.locator("[data-voice-end]")).toBeHidden();
  await expect(page.locator("[data-voice-start]")).toBeVisible();
  await expect.poll(() => ctl.commands.length).toBe(1);
  const stop = ctl.commands[0];
  expect(stop.authorization).toBe("Bearer " + SESSION_TOKEN);
  expect(stop.url).toBe("/v1/session/" + SESSION_ID + "/commands");
  expect(stop.body.type).toBe("stop");
  expect(stop.body.session_id).toBe(SESSION_ID);
  expect(stop.body.expected_version).toBe(0);
  expect(stop.body.command_id).toMatch(/^cmd-[0-9a-f]{32}$/);
  const closed = await page.evaluate(() => window.__voiceStub.closed);
  const tracks = await page.evaluate(() => window.__voiceStub.stoppedTracks);
  expect(closed).toBeGreaterThan(0);
  expect(tracks).toBeGreaterThan(0);
  ctl.releaseTalks();
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => window.__voiceStub.closed)).toBe(closed);
  expect(await page.evaluate(() => window.__voiceStub.stoppedTracks)).toBe(tracks);
  expect(await spokenReply(page, "Reply: Hold this reply")).toBe(false);
  expect(await page.evaluate(() => ({
    onmessage: window.__voiceStub.conns[0].channel.onmessage,
    onopen: window.__voiceStub.conns[0].channel.onopen,
    onclose: window.__voiceStub.conns[0].channel.onclose
  }))).toEqual({ onmessage: null, onopen: null, onclose: null });
});

test("a voice 409 stays recoverable and End still sends stop", async ({ page }) => {
  ctl.voiceEnabled = true;
  ctl.voiceStatus = 409;
  await installVoiceStub(page);
  await page.goto(site.origin + "/voice-harness.html");
  await page.locator("[data-voice-start]").click();
  await expect(page.locator("[data-voice-status]")).toHaveText("Voice is busy for this session.");
  await expect(page.locator("[data-voice-start]")).toBeVisible();
  await expect(page.locator("[data-voice-end]")).toBeVisible();
  expect(await page.evaluate(() => window.__voiceStub.stoppedTracks)).toBeGreaterThan(0);
  await page.locator("[data-voice-end]").click();
  await expect.poll(() => ctl.commands.filter((cmd) => cmd.body && cmd.body.type === "stop").length).toBe(1);
  await expect(page.locator("[data-voice-end]")).toBeHidden();
  await expect(page.locator("[data-voice-start]")).toBeVisible();
});

test("a talk 410 ends the call and a new Start opens another session", async ({ page }) => {
  ctl.talkStatus = 410;
  await openVoice(page);
  await say(page, "item-410", "Is this still here");
  await expect(page.locator("[data-voice-status]")).toHaveText("This session has ended.");
  await expect(page.locator("[data-voice-start]")).toBeVisible();
  await expect(page.locator("[data-voice-end]")).toBeHidden();
  expect(await page.evaluate(() => window.__voiceStub.closed)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__voiceStub.stoppedTracks)).toBeGreaterThan(0);
  expect(ctl.commands.filter((cmd) => cmd.body && cmd.body.type === "stop")).toHaveLength(0);
  ctl.talkStatus = 200;
  await page.locator("[data-voice-start]").click();
  await expect(page.locator("[data-voice-status]")).toHaveText("Listening");
  expect(ctl.sessions).toHaveLength(2);
  expect(ctl.sessions[1].body.creation_id).not.toBe(ctl.sessions[0].body.creation_id);
  expect(ctl.voiceCalls).toHaveLength(2);
});

test("the agent choice is shown only when health lists more than one, and locks at Start", async ({ page }) => {
  ctl.voiceEnabled = true;
  ctl.agents = ["claude", "openai"];
  await installVoiceStub(page);
  await page.goto(site.origin + "/voice-harness.html");
  const claude = page.locator("[data-voice-agent-choice][value=claude]");
  const openai = page.locator("[data-voice-agent-choice][value=openai]");
  await expect(page.locator("[data-voice-agent]")).toBeVisible();
  await openai.check();
  await page.locator("[data-voice-start]").click();
  await expect(page.locator("[data-voice-status]")).toHaveText("Listening");
  await expect(claude).toBeDisabled();
  await expect(openai).toBeDisabled();
  await page.evaluate(() => {
    const input = document.querySelector("[data-voice-agent-choice][value=claude]");
    input.disabled = false;
    input.checked = true;
  });
  await say(page, "item-agent", "Use the locked agent");
  await expect.poll(() => ctl.talkCalls.length).toBe(1);
  expect(ctl.talkCalls[0].body.agent).toBe("openai");
});
