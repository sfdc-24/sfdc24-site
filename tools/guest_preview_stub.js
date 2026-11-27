/* The guest seat preview's stand-ins (tools/guest_preview.py). Never served by the site.
   - window.__guestPreviewLoc: the address the page's scripts read, as if it were /guest/?demo=1#PREVIEW-PASS.
   - fetch(): the join config, and a demo pass's join answer (a 15 minute solo seat), or a refusal.
   - window.LivekitClient: a room in this page only. Rigel joins, then a sample shared screen drawn on a canvas.
   - the Preview bar: the welcome line (a, b, c), a scenario, and Restart (kept in sessionStorage when it can be). */
(function () {
  "use strict";

  var KEY = "sfdc24-guest-preview";
  var settings = { notice: "a", scenario: "normal" };
  try {
    var kept = JSON.parse(sessionStorage.getItem(KEY) || "{}");
    if (kept && typeof kept === "object") {
      if (/^[abc]$/.test(kept.notice || "")) settings.notice = kept.notice;
      if (/^(normal|mic|sound|used)$/.test(kept.scenario || "")) settings.scenario = kept.scenario;
    }
  } catch (err) {}

  var loc = {
    pathname: "/guest/",
    search: "?demo=1&notice=" + settings.notice,
    hash: "#PREVIEW-PASS",
    replaceState: function (state, title, url) {
      var text = String(url || "");
      var cut = text.indexOf("#");
      if (cut !== -1) text = text.slice(0, cut);
      var q = text.indexOf("?");
      loc.search = q === -1 ? "" : text.slice(q);
      loc.hash = "";
    }
  };
  window.__guestPreviewLoc = loc;

  function save(next) {
    try { sessionStorage.setItem(KEY, JSON.stringify(next)); } catch (err) {}
  }

  // fetch: only the page's two calls are answered; anything else is refused, as nothing may leave the preview.
  var posted = [];
  window.__guestPreviewPosted = posted;
  window.fetch = function (url, options) {
    var path = String(url || "");
    function reply(status, body) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          resolve({
            ok: status >= 200 && status < 300,
            status: status,
            json: function () { return Promise.resolve(body); },
            text: function () { return Promise.resolve(JSON.stringify(body)); }
          });
        }, 450);
      });
    }
    if (path === "/data/guest-join.json") return reply(200, { serviceUrl: "https://preview.invalid" });
    if (path === "https://preview.invalid/api/guest/join") {
      var body = {};
      try { body = JSON.parse(options && options.body || "{}"); } catch (err) {}
      posted.push({ record: body.record });
      if (settings.scenario === "used") {
        return reply(403, { error: "This demo pass has been used up. Thank you for trying the demo." });
      }
      var deadline = Math.floor(Date.now() / 1000) + 15 * 60;
      return reply(200, {
        livekit_url: "wss://preview.invalid", room: "preview", identity: "gst_preview", join_token: "preview",
        join_expires_at: deadline, name: "Guest", role: "solo_demo", deadline: deadline,
        solo: { mode: "demo", minutes: 15, call: 1, max_calls: 2, max_minutes: 20, rejoin: false, deadline: deadline,
                record: body.record !== false }
      });
    }
    return Promise.reject(new Error("the preview makes no network calls"));
  };

  // The sample shared screen: a CRM pipeline view at desktop size (1440 x 900), so its size on a phone is the real one.
  function drawScreen(canvas, t) {
    var g = canvas.getContext("2d");
    var W = canvas.width, H = canvas.height;
    g.fillStyle = "#F3F3F3"; g.fillRect(0, 0, W, H);
    g.fillStyle = "#032D60"; g.fillRect(0, 0, W, 56);
    g.fillStyle = "#FFFFFF"; g.font = "600 20px system-ui, sans-serif"; g.fillText("Sample Org  ·  Sales", 24, 36);
    g.font = "15px system-ui, sans-serif";
    ["Home", "Leads", "Accounts", "Opportunities", "Reports"].forEach(function (tab, i) {
      g.fillStyle = i === 3 ? "#FFFFFF" : "#B9C7DA"; g.fillText(tab, 320 + i * 130, 36);
    });
    g.fillStyle = "#FFFFFF"; g.fillRect(24, 80, W - 48, 120);
    g.fillStyle = "#181818"; g.font = "700 26px system-ui, sans-serif"; g.fillText("Open pipeline this quarter", 48, 124);
    var cards = [["$1.84M", "Open pipeline"], ["37", "Open opportunities"], ["42%", "Win rate"], ["18 days", "Avg. time in stage"]];
    cards.forEach(function (c, i) {
      g.fillStyle = "#0B5CAB"; g.font = "700 28px system-ui, sans-serif"; g.fillText(c[0], 48 + i * 330, 172);
      g.fillStyle = "#5C5C5C"; g.font = "15px system-ui, sans-serif"; g.fillText(c[1], 48 + i * 330, 192);
    });
    g.fillStyle = "#FFFFFF"; g.fillRect(24, 220, W - 48, H - 244);
    var cols = [["Opportunity", 48], ["Account", 470], ["Stage", 760], ["Amount", 1000], ["Close date", 1180]];
    g.fillStyle = "#444444"; g.font = "600 15px system-ui, sans-serif";
    cols.forEach(function (c) { g.fillText(c[0], c[1], 256); });
    var rows = [
      ["Fleet telematics rollout", "Acme Logistics", "Proposal", "$420,000", "Dec 12"],
      ["Clinic scheduling upgrade", "Bluebird Dental", "Discovery", "$86,000", "Jan 9"],
      ["Service contract renewal", "Cedar Home Services", "Negotiation", "$212,000", "Dec 19"],
      ["Member app and loyalty", "Delta Fitness", "Qualification", "$150,000", "Feb 2"],
      ["Agent portal", "Evergreen Realty", "Proposal", "$310,000", "Dec 30"],
      ["Field service pilot", "Foxglove Utilities", "Discovery", "$95,000", "Jan 22"],
      ["Partner onboarding", "Granite Supply Co.", "Closed Won", "$188,000", "Nov 20"]
    ];
    var hot = Math.floor(t / 1600) % rows.length;
    rows.forEach(function (r, i) {
      var y = 300 + i * 64;
      if (i === hot) { g.fillStyle = "#EAF5FE"; g.fillRect(32, y - 34, W - 64, 56); }
      g.fillStyle = "#E5E5E5"; g.fillRect(32, y + 22, W - 64, 1);
      g.fillStyle = "#0B5CAB"; g.font = "600 17px system-ui, sans-serif"; g.fillText(r[0], 48, y);
      g.fillStyle = "#181818"; g.font = "17px system-ui, sans-serif";
      g.fillText(r[1], 470, y); g.fillText(r[2], 760, y); g.fillText(r[3], 1000, y); g.fillText(r[4], 1180, y);
    });
    var cx = 600 + Math.sin(t / 900) * 260, cy = 330 + hot * 64;
    g.fillStyle = "#111111"; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx, cy + 22); g.lineTo(cx + 6, cy + 17);
    g.lineTo(cx + 15, cy + 18); g.closePath(); g.fill();
  }

  function screenTrack() {
    var canvas = document.createElement("canvas");
    canvas.width = 1440; canvas.height = 900;
    var start = Date.now();
    drawScreen(canvas, 0);
    var reduce = false;
    try { reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (err) {}
    if (!reduce) setInterval(function () { drawScreen(canvas, Date.now() - start); }, 120);
    var stream = null;
    try { stream = canvas.captureStream ? canvas.captureStream(10) : null; } catch (err) { stream = null; }
    return {
      kind: "video",
      attach: function () {
        var video = document.createElement("video");
        if (stream) {
          video.srcObject = stream;
        } else {
          video.poster = canvas.toDataURL("image/png");
        }
        return video;
      },
      detach: function () { return []; }
    };
  }

  function audioTrack() {
    return { kind: "audio", attach: function () { return document.createElement("audio"); }, detach: function () { return []; } };
  }

  function Participant(identity, name, isLocal) {
    this.identity = identity;
    this.name = name || "";
    this.isLocal = !!isLocal;
    this.audioTrackPublications = new Map();
    this.videoTrackPublications = new Map();
    this.attributes = {};
  }

  function Room() {
    var room = this;
    this.handlers = {};
    this.remoteParticipants = new Map();
    this.localParticipant = new Participant("gst_preview", "Guest", true);
    this.canPlaybackAudio = settings.scenario !== "sound";
    this.localParticipant.setMicrophoneEnabled = function (on) {
      return new Promise(function (resolve, reject) {
        setTimeout(function () {
          if (on && settings.scenario === "mic") reject(new Error("denied"));
          else resolve();
        }, 700);
      });
    };
    this.startAudio = function () {
      room.canPlaybackAudio = true;
      room.emit("audioPlaybackChanged", true);
      return Promise.resolve();
    };
  }
  Room.prototype.on = function (event, fn) {
    (this.handlers[event] = this.handlers[event] || []).push(fn);
    return this;
  };
  Room.prototype.emit = function (event) {
    var args = Array.prototype.slice.call(arguments, 1);
    (this.handlers[event] || []).forEach(function (fn) { fn.apply(null, args); });
  };
  Room.prototype.connect = function () {
    var room = this;
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve();
        setTimeout(function () {
          if (room.gone) return;
          var rigel = new Participant("agent-preview-chair", "Rigel", false);
          room.remoteParticipants.set(rigel.identity, rigel);
          room.emit("participantConnected", rigel);
          room.emit("trackSubscribed", audioTrack(), { kind: "audio" }, rigel);
        }, 900);
        setTimeout(function () {
          if (room.gone) return;
          var screen = new Participant("scr_preview", "Shared screen", false);
          room.remoteParticipants.set(screen.identity, screen);
          room.emit("participantConnected", screen);
          room.emit("trackSubscribed", screenTrack(), { kind: "video" }, screen);
        }, 2400);
      }, 600);
    });
  };
  Room.prototype.disconnect = function () {
    this.gone = true;
    this.emit("disconnected");
    return Promise.resolve();
  };

  window.LivekitClient = {
    Room: Room,
    RoomEvent: {
      TrackSubscribed: "trackSubscribed",
      TrackUnsubscribed: "trackUnsubscribed",
      ParticipantConnected: "participantConnected",
      ParticipantDisconnected: "participantDisconnected",
      ParticipantAttributesChanged: "participantAttributesChanged",
      Disconnected: "disconnected",
      DataReceived: "dataReceived",
      ActiveSpeakersChanged: "activeSpeakersChanged",
      AudioPlaybackStatusChanged: "audioPlaybackChanged"
    },
    LogLevel: { silent: 5 },
    setLogLevel: function () {}
  };

  function wireBar() {
    function paint() {
      ["a", "b", "c"].forEach(function (n) {
        var b = document.getElementById("pv-notice-" + n);
        if (b) b.setAttribute("aria-pressed", String(settings.notice === n));
      });
      ["normal", "mic", "sound", "used"].forEach(function (s) {
        var b = document.getElementById("pv-s-" + s);
        if (b) b.setAttribute("aria-pressed", String(settings.scenario === s));
      });
    }
    function restart() {
      save(settings);
      try { location.reload(); } catch (err) {}
    }
    var bar = document.getElementById("pv-bar");
    if (!bar) return;
    bar.addEventListener("click", function (event) {
      var target = event.target;
      if (!target || target.tagName !== "BUTTON") return;
      if (target.getAttribute("data-pv-notice")) settings.notice = target.getAttribute("data-pv-notice");
      if (target.getAttribute("data-pv-scenario")) settings.scenario = target.getAttribute("data-pv-scenario");
      paint();
      restart();
    });
    paint();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireBar);
  else wireBar();
})();
