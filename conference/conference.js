/* Owner join for /conference/.
   Calls a same-origin or www.sfdc24.com token URL only when gateway.json
   names one. No room is opened here. Beacons stay free of tokens and names. */
(function (root, factory) {
  "use strict";
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && root.document && root.document.getElementById && root.document.getElementById("join-conference")) {
    api.mount(root);
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  var WAITING = "Join unavailable — waiting on gateway token";
  var TOKEN_HELD = "Join token received. This page cannot open a room yet, so nothing was connected.";
  var RELEASED = "Join token received. No room client is on this page, so the microphone and camera were released.";
  var PERMISSION = "Microphone or camera permission was blocked.";
  var STORE = "sfdc24_conf_events";
  var MAX = 40;
  var DROP = /token|secret|authorization|cookie|email|name|transcript|sdp|bearer/i;

  function isRelative(value) {
    return typeof value === "string" &&
      value.charAt(0) === "/" &&
      value.charAt(1) !== "/" &&
      value.indexOf("\\") === -1 &&
      value.indexOf("..") === -1 &&
      !/\s/.test(value);
  }

  function httpsUrl(value) {
    if (typeof value !== "string" || /\s/.test(value)) return null;
    var u;
    try { u = new URL(value); } catch (e) { return null; }
    if (u.protocol !== "https:" || u.username || u.password) return null;
    if (u.search && /token|key|secret|code=/i.test(u.search)) return null;
    var host = u.hostname.toLowerCase();
    if (host !== "www.sfdc24.com" && host !== "sfdc24.com") return null;
    return u;
  }

  function isSafeTokenUrl(value) {
    if (value == null || value === "") return false;
    if (isRelative(value)) return true;
    return !!httpsUrl(value);
  }

  function isSafeRoomUrl(value) {
    if (typeof value !== "string" || /\s/.test(value)) return false;
    var u;
    try { u = new URL(value); } catch (e) { return false; }
    if (u.username || u.password) return false;
    return u.protocol === "wss:" || u.protocol === "https:";
  }

  function scrubString(s) {
    return String(s)
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig, "[email]")
      .replace(/\b(?:sk-|ghp_|github_pat_|ya29\.)[A-Za-z0-9._-]{8,}/g, "[secret]")
      .slice(0, 160);
  }

  function scrub(value, depth) {
    if (value == null || typeof value === "boolean" || typeof value === "number") return value;
    if (typeof value === "string") return scrubString(value);
    if (typeof value !== "object" || depth > 4) return null;
    if (Array.isArray(value)) return value.slice(0, 8).map(function (item) { return scrub(item, depth + 1); });
    var out = {};
    Object.keys(value).forEach(function (key) {
      if (DROP.test(key)) return;
      out[key] = scrub(value[key], depth + 1);
    });
    return out;
  }

  function viewportOf(win) {
    var w = 0;
    var h = 0;
    var dpr = 1;
    var vv = 0;
    try {
      w = win.innerWidth || 0;
      h = win.innerHeight || 0;
      dpr = win.devicePixelRatio || 1;
      if (win.visualViewport && win.visualViewport.height) vv = win.visualViewport.height;
    } catch (e) {}
    return {
      w: Math.round(w),
      h: Math.round(h),
      dpr: Math.round(dpr * 100) / 100,
      vv_h: Math.round(vv)
    };
  }

  function readStore(storage) {
    try {
      var parsed = JSON.parse(storage.getItem(STORE) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function writeStore(storage, events) {
    try { storage.setItem(STORE, JSON.stringify(events.slice(-MAX))); } catch (e) {}
  }

  function createClient(deps) {
    deps = deps || {};
    var win = deps.window || {};
    var events = [];
    var phase = "idle";
    var gateway = { schema: 1, tokenUrl: null, beaconUrl: null, media: false };
    var recordOptIn = false;

    function storage() {
      return deps.storage || win.sessionStorage || null;
    }

    function beacon(type, detail) {
      var event = scrub({
        v: 1,
        type: type,
        at: new Date().toISOString(),
        path: "/conference/",
        viewport: viewportOf(win),
        record_opt_in: !!recordOptIn,
        detail: detail || {}
      }, 0);
      events.push(event);
      if (events.length > MAX) events.splice(0, events.length - MAX);
      var store = storage();
      if (store) writeStore(store, readStore(store).concat([event]));
      var send = deps.sendBeacon;
      if (typeof send !== "function" && win.navigator && win.navigator.sendBeacon) {
        send = win.navigator.sendBeacon.bind(win.navigator);
      }
      if (isSafeTokenUrl(gateway.beaconUrl) && typeof send === "function") {
        try {
          var body = typeof Blob !== "undefined"
            ? new Blob([JSON.stringify(event)], { type: "application/json" })
            : JSON.stringify(event);
          send(gateway.beaconUrl, body);
        } catch (e) {}
      }
      return event;
    }

    function setPhase(next) { phase = next; }

    async function loadGateway() {
      var fetchImpl = deps.fetch;
      if (typeof fetchImpl !== "function") return gateway;
      try {
        var res = await fetchImpl("gateway.json", {
          method: "GET",
          credentials: "omit",
          cache: "no-store",
          headers: { accept: "application/json" }
        });
        if (!res || !res.ok) return gateway;
        var data = await res.json();
        if (!data || typeof data !== "object") return gateway;
        gateway = {
          schema: 1,
          tokenUrl: isSafeTokenUrl(data.tokenUrl) ? data.tokenUrl : null,
          beaconUrl: isSafeTokenUrl(data.beaconUrl) ? data.beaconUrl : null,
          media: data.media === true
        };
      } catch (e) {}
      return gateway;
    }

    async function readToken(fetchImpl, method) {
      return fetchImpl(gateway.tokenUrl, {
        method: method,
        credentials: "omit",
        cache: "no-store",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: method === "POST" ? JSON.stringify({ role: "owner" }) : undefined
      });
    }

    async function decideJoin() {
      var fetchImpl = deps.fetch;
      if (!isSafeTokenUrl(gateway.tokenUrl) || typeof fetchImpl !== "function") {
        return { state: "waiting", message: WAITING, reason: "missing" };
      }
      var res;
      try {
        res = await readToken(fetchImpl, "POST");
      } catch (e) {
        return { state: "waiting", message: WAITING, reason: "network" };
      }
      if (res && res.status === 405) {
        try { res = await readToken(fetchImpl, "GET"); }
        catch (e2) { return { state: "waiting", message: WAITING, reason: "network" }; }
      }
      var data = null;
      try { data = res && res.json ? await res.json() : null; } catch (e3) { data = null; }
      var token = data && typeof data.token === "string" ? data.token : "";
      var room = data && (data.url || data.serverUrl);
      if (!res || !res.ok || !token || !isSafeRoomUrl(room)) {
        return { state: "waiting", message: WAITING, reason: "http" };
      }
      return { state: "token", message: TOKEN_HELD, media: gateway.media === true };
    }

    function notePermissionFailure(err) {
      var name = err && err.name ? String(err.name) : "";
      var reason = name === "NotAllowedError" || name === "NotFoundError" || name === "SecurityError" ? name : "blocked";
      beacon("av_permission_failure", { reason: reason });
    }

    function noteDisconnect(reason) {
      if (phase !== "joining" && phase !== "media") return null;
      var event = beacon("disconnect", { reason: reason || "dropped" });
      phase = "dropped";
      return event;
    }

    function stopStream(stream) {
      try {
        if (stream && stream.getTracks) stream.getTracks().forEach(function (track) { track.stop(); });
      } catch (e) {}
    }

    async function requestMedia() {
      var media = deps.getUserMedia;
      if (typeof media !== "function" && win.navigator && win.navigator.mediaDevices && win.navigator.mediaDevices.getUserMedia) {
        media = win.navigator.mediaDevices.getUserMedia.bind(win.navigator.mediaDevices);
      }
      if (typeof media !== "function") {
        notePermissionFailure({ name: "NotFoundError" });
        return null;
      }
      try {
        return await media({ audio: true, video: true });
      } catch (err) {
        notePermissionFailure(err);
        return null;
      }
    }

    async function join() {
      phase = "joining";
      beacon("join_attempt", {});
      await loadGateway();
      var decision = await decideJoin();
      if (decision.state !== "token" || !decision.media) {
        phase = "waiting";
        return decision;
      }
      phase = "media";
      var stream = await requestMedia();
      stopStream(stream);
      phase = "waiting";
      if (!stream) return { state: "waiting", message: PERMISSION };
      return { state: "waiting", message: RELEASED };
    }

    return {
      beacon: beacon,
      events: events,
      loadGateway: loadGateway,
      decideJoin: decideJoin,
      join: join,
      noteDisconnect: noteDisconnect,
      setRecordOptIn: function (on) { recordOptIn = !!on; },
      setPhase: setPhase,
      phase: function () { return phase; },
      gateway: function () { return gateway; }
    };
  }

  function mount(win) {
    var doc = win.document;
    var status = doc.getElementById("join-status");
    var button = doc.getElementById("join-conference");
    var opt = doc.getElementById("record-opt-in");
    var client = createClient({ window: win, fetch: win.fetch ? win.fetch.bind(win) : null });
    win.SFDC24Conference = client;

    function paint(message) {
      if (status && message) status.textContent = message;
    }

    var resizeTimer = 0;
    win.addEventListener("resize", function () {
      win.clearTimeout(resizeTimer);
      resizeTimer = win.setTimeout(function () { client.beacon("viewport", {}); }, 400);
    });
    win.addEventListener("offline", function () { client.noteDisconnect("offline"); });
    win.addEventListener("pagehide", function () { client.noteDisconnect("pagehide"); });

    client.loadGateway().then(function () {
      client.beacon("viewport", {});
      if (!client.gateway().tokenUrl) paint(WAITING);
    });

    if (opt) {
      opt.addEventListener("change", function () { client.setRecordOptIn(!!opt.checked); });
    }
    if (button) {
      button.addEventListener("click", function () {
        client.setRecordOptIn(!!(opt && opt.checked));
        button.setAttribute("aria-busy", "true");
        client.join().then(function (decision) {
          paint(decision && decision.message ? decision.message : WAITING);
        }).catch(function () {
          paint(WAITING);
        }).then(function () {
          button.removeAttribute("aria-busy");
        });
      });
    }
  }

  return {
    WAITING: WAITING,
    TOKEN_HELD: TOKEN_HELD,
    RELEASED: RELEASED,
    PERMISSION: PERMISSION,
    isSafeTokenUrl: isSafeTokenUrl,
    isSafeRoomUrl: isSafeRoomUrl,
    scrub: scrub,
    createClient: createClient,
    mount: mount
  };
});
