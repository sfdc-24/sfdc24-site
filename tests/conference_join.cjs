const test = require("node:test");
const assert = require("node:assert/strict");
const join = require("../conference/conference.js");

const TOKEN = "sekret-token-value-should-not-leak";

function store() {
  const mem = new Map();
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v))
  };
}

function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

test("missing token url stays on the waiting copy and does not fetch a room", async () => {
  const calls = [];
  const client = join.createClient({
    fetch: async (url, opts) => {
      calls.push({ url, method: opts.method, body: opts.body, credentials: opts.credentials });
      if (url === "gateway.json") return jsonRes(200, { tokenUrl: null, beaconUrl: null, media: false });
      throw new Error("unexpected " + url);
    },
    storage: store(),
    window: { innerWidth: 390, innerHeight: 640, devicePixelRatio: 2, visualViewport: { height: 620 } }
  });
  await client.loadGateway();
  const view = client.beacon("viewport", {});
  assert.equal(view.type, "viewport");
  assert.equal(view.viewport.w, 390);
  assert.equal(view.viewport.h, 640);
  assert.equal(view.viewport.vv_h, 620);
  assert.equal(view.record_opt_in, false);
  const decision = await client.join();
  assert.equal(decision.message, join.WAITING);
  assert.equal(decision.state, "waiting");
  assert.deepEqual(calls.map((c) => c.url), ["gateway.json", "gateway.json"]);
  assert.equal(client.events.some((e) => e.type === "join_attempt"), true);
  assert.equal(JSON.stringify(client.events).includes(TOKEN), false);
});

test("unsafe token and beacon urls are ignored", async () => {
  const calls = [];
  let sent = 0;
  const client = join.createClient({
    fetch: async (url) => {
      calls.push(url);
      return jsonRes(200, {
        tokenUrl: "https://evil.example/join?token=abc",
        beaconUrl: "http://www.sfdc24.com/leak",
        media: true
      });
    },
    sendBeacon: () => { sent += 1; return true; },
    storage: store()
  });
  await client.loadGateway();
  client.beacon("viewport", {});
  const decision = await client.join();
  assert.equal(decision.reason, "missing");
  assert.equal(client.gateway().tokenUrl, null);
  assert.equal(client.gateway().beaconUrl, null);
  assert.equal(sent, 0);
  assert.deepEqual(calls, ["gateway.json", "gateway.json"]);
  assert.equal(join.isSafeTokenUrl("/conference/token"), true);
  assert.equal(join.isSafeTokenUrl("//evil.example/token"), false);
  assert.equal(join.isSafeTokenUrl("https://user:pass@www.sfdc24.com/token"), false);
  assert.equal(join.isSafeRoomUrl("wss://rooms.example/live"), true);
  assert.equal(join.isSafeRoomUrl("javascript:alert(1)"), false);
});

test("a safe token endpoint is called and the token never enters the beacon", async () => {
  const calls = [];
  const client = join.createClient({
    fetch: async (url, opts) => {
      calls.push({ url, method: opts.method, body: opts.body, credentials: opts.credentials });
      if (url === "gateway.json") {
        return jsonRes(200, { tokenUrl: "https://www.sfdc24.com/conference/token", beaconUrl: null, media: false });
      }
      return jsonRes(200, { token: TOKEN, url: "wss://www.sfdc24.com/room" });
    },
    storage: store(),
    getUserMedia: async () => { throw new Error("media should stay off"); }
  });
  client.setRecordOptIn(false);
  const decision = await client.join();
  assert.equal(decision.state, "token");
  assert.equal(decision.message, join.TOKEN_HELD);
  assert.equal(Object.hasOwn(decision, "token"), false);
  const post = calls.find((c) => c.url === "https://www.sfdc24.com/conference/token");
  assert.equal(post.method, "POST");
  assert.equal(post.credentials, "omit");
  assert.equal(post.body, JSON.stringify({ role: "owner" }));
  const flat = JSON.stringify(client.events);
  assert.equal(flat.includes(TOKEN), false);
  assert.equal(client.events.some((e) => e.type === "av_permission_failure"), false);
});

test("POST 405 falls back to GET", async () => {
  const methods = [];
  const client = join.createClient({
    fetch: async (url, opts) => {
      if (url === "gateway.json") return jsonRes(200, { tokenUrl: "/conference/token", media: false });
      methods.push(opts.method);
      if (opts.method === "POST") return jsonRes(405, {});
      return jsonRes(200, { token: TOKEN, serverUrl: "https://www.sfdc24.com/room" });
    },
    storage: store()
  });
  const decision = await client.join();
  assert.equal(decision.state, "token");
  assert.deepEqual(methods, ["POST", "GET"]);
});

test("opt-in media permission failure is beaconed and a denial does not record", async () => {
  let asked = 0;
  const client = join.createClient({
    fetch: async (url) => {
      if (url === "gateway.json") {
        return jsonRes(200, { tokenUrl: "/conference/token", beaconUrl: "/conference/events", media: true });
      }
      return jsonRes(200, { token: TOKEN, url: "wss://www.sfdc24.com/room" });
    },
    storage: store(),
    getUserMedia: async () => {
      asked += 1;
      const err = new Error("denied");
      err.name = "NotAllowedError";
      throw err;
    },
    sendBeacon: () => true
  });
  client.setRecordOptIn(true);
  const decision = await client.join();
  assert.equal(asked, 1);
  assert.equal(decision.message, join.PERMISSION);
  const failure = client.events.find((e) => e.type === "av_permission_failure");
  assert.equal(failure.detail.reason, "NotAllowedError");
  assert.equal(failure.record_opt_in, true);
  assert.equal(JSON.stringify(client.events).includes(TOKEN), false);
});

test("media tracks are stopped when a token arrives and there is still no room client", async () => {
  let stopped = 0;
  const client = join.createClient({
    fetch: async (url) => {
      if (url === "gateway.json") return jsonRes(200, { tokenUrl: "/conference/token", media: true });
      return jsonRes(200, { token: TOKEN, url: "wss://www.sfdc24.com/room" });
    },
    storage: store(),
    getUserMedia: async () => ({ getTracks: () => [{ stop: () => { stopped += 1; } }] })
  });
  const decision = await client.join();
  assert.equal(decision.message, join.RELEASED);
  assert.equal(stopped, 1);
  assert.equal(client.events.some((e) => e.type === "av_permission_failure"), false);
});

test("disconnect beacons only during an active join", () => {
  const client = join.createClient({ storage: store(), window: { innerWidth: 320, innerHeight: 568 } });
  assert.equal(client.noteDisconnect("offline"), null);
  client.setPhase("joining");
  const event = client.noteDisconnect("offline");
  assert.equal(event.type, "disconnect");
  assert.equal(event.detail.reason, "offline");
  assert.equal(client.noteDisconnect("pagehide"), null);
});

test("beacon scrub drops secrets, mail, and name fields", () => {
  const dirty = join.scrub({
    token: TOKEN,
    email: "person@example.com",
    name: "Yasmine",
    detail: { note: "reach person@example.com", reason: "network" }
  }, 0);
  assert.equal(Object.hasOwn(dirty, "token"), false);
  assert.equal(Object.hasOwn(dirty, "email"), false);
  assert.equal(Object.hasOwn(dirty, "name"), false);
  assert.equal(dirty.detail.note.includes("@"), false);
  assert.equal(dirty.detail.reason, "network");
});
