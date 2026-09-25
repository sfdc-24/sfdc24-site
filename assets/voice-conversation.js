/* Homepage voice conversation.
 *
 * One Start, one End. Between them the microphone stays open and turns are
 * detected automatically: each thing the visitor says is transcribed by the
 * OpenAI Realtime session, answered by the selected agent through the studio
 * controller talk lane (POST /v1/session/{id}/talk, Claude or OpenAI), and
 * spoken back through the same realtime session as streamed OpenAI voice. The
 * visitor can talk over the reply; the realtime server cancels it and older
 * queued lines are dropped. The browser never holds a provider key: the
 * controller relays the WebRTC offer with its own credential.
 *
 * Sign-in is the studio email code, stored under the same sessionStorage
 * key, so a sign-in on /studio/ also works here and the other way round.
 */
(function () {
  "use strict";

  var OPERATOR_KEY = "studio.operator";

  function randomHex(bytes) {
    var a = new Uint8Array(bytes);
    if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(a);
    else for (var i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
    var out = "";
    for (var j = 0; j < a.length; j++) out += ("0" + a[j].toString(16)).slice(-2);
    return out;
  }

  function parseJson(text) {
    try { var v = JSON.parse(text); return v && typeof v === "object" ? v : {}; } catch (e) { return {}; }
  }

  function readOperator() {
    try {
      var stored = parseJson(sessionStorage.getItem(OPERATOR_KEY) || "");
      if (!stored.token) return "";
      var exp = stored.expires_at;
      if (exp !== "" && exp != null) {
        var ms = typeof exp === "number" ? exp * 1000 : Date.parse(exp);
        if (!isFinite(ms) || ms <= Date.now()) { sessionStorage.removeItem(OPERATOR_KEY); return ""; }
      }
      return String(stored.token);
    } catch (e) { return ""; }
  }

  function writeOperator(token, expiresAt) {
    try { sessionStorage.setItem(OPERATOR_KEY, JSON.stringify({ token: token, expires_at: expiresAt || "" })); } catch (e) {}
  }

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) n.setAttribute(k, attrs[k]);
    if (text) n.textContent = text;
    return n;
  }

  function mount(root, opts) {
    var base = String((opts && opts.controllerUrl) || root.getAttribute("data-controller-url") || "").replace(/\/+$/, "");
    if (!base || !root) return null;

    var ui = {
      start: el("button", { type: "button", "class": "vc-start", "data-vc-start": "" }, "Start conversation"),
      end: el("button", { type: "button", "class": "vc-end", "data-vc-end": "", hidden: "" }, "End conversation"),
      agent: el("select", { "class": "vc-agent", "data-vc-agent": "", "aria-label": "Who answers", hidden: "" }),
      status: el("p", { "class": "vc-status", "data-vc-status": "", role: "status", "aria-live": "polite" }),
      signin: el("form", { "class": "vc-signin", "data-vc-signin": "", hidden: "" }),
      caption: el("p", { "class": "vc-caption", "data-vc-caption": "", hidden: "" }),
      audio: el("audio", { "data-vc-audio": "", autoplay: "" })
    };
    var email = el("input", { type: "email", "data-vc-email": "", autocomplete: "email", "aria-label": "Email" });
    var code = el("input", { type: "text", "data-vc-code": "", inputmode: "numeric", autocomplete: "one-time-code",
                             "aria-label": "Six-digit code", maxlength: "6", hidden: "" });
    var go = el("button", { type: "submit" }, "Send code");
    ui.signin.appendChild(email); ui.signin.appendChild(code); ui.signin.appendChild(go);
    var row = el("div", { "class": "vc-row" });
    row.appendChild(ui.start); row.appendChild(ui.agent); row.appendChild(ui.end);
    root.appendChild(row); root.appendChild(ui.signin); root.appendChild(ui.status);
    root.appendChild(ui.caption); root.appendChild(ui.audio);

    var s = null;          // the live conversation, or null
    var gen = 0;           // bumps on every start and end; late callbacks compare against it
    var signin = { challenge: "", key: "", email: "" };
    var LABELS = { you: "You", claude: "Claude", openai: "OpenAI" };

    // The live canvas (assets/prototype-canvas.js), when the page has one:
    // everything said is also sent to the builder, and what the builder
    // confirms or asks is spoken in this same call.
    var canvasRoot = document.getElementById("prototype-canvas");
    var analystOn = false;
    var canvas = canvasRoot && window.SFDC24Canvas ? window.SFDC24Canvas.create(canvasRoot, {
      base: base,
      speak: function (line) { if (s) speak(line, s.turn, "build"); }
    }) : null;

    function say(text) { ui.status.textContent = text || ""; }

    /* A caption of the line being said now, not a transcript. */
    function caption(who, text) {
      ui.caption.textContent = "";
      ui.caption.setAttribute("data-who", who);
      ui.caption.appendChild(el("b", {}, (LABELS[who] || who) + ": "));
      ui.caption.appendChild(document.createTextNode(text));
      ui.caption.hidden = false;
    }

    function health() {
      return fetch(base + "/health", { cache: "no-store", credentials: "omit" })
        .then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; });
    }

    health().then(function (h) {
      var f = (h && h.features) || {};
      if (!f.voice || !f.talk) { root.hidden = true; return; }
      analystOn = !!f.analyst;
      var agents = Array.isArray(f.agents) ? f.agents : [];
      ui.agent.textContent = "";
      agents.forEach(function (a) {
        var o = el("option", { value: a }, a === "claude" ? "Claude" : a === "openai" ? "OpenAI" : a);
        ui.agent.appendChild(o);
      });
      ui.agent.hidden = agents.length < 2;
      root.hidden = false;
    });

    function post(path, token, body) {
      return fetch(base + path, {
        method: "POST", credentials: "omit", cache: "no-store",
        headers: { "authorization": "Bearer " + token, "content-type": "application/json", "accept": "application/json" },
        body: JSON.stringify(body)
      }).then(function (r) { return r.text().then(function (t) { return { status: r.status, body: parseJson(t) }; }); });
    }

    /* --- sign-in: the studio email code ------------------------------- */
    ui.signin.addEventListener("submit", function (ev) {
      ev.preventDefault();
      if (!signin.challenge) {
        var addr = String(email.value || "").trim().toLowerCase();
        if (!addr) return;
        signin.key = randomHex(16); signin.email = addr;
        fetch(base + "/v1/auth/start", {
          method: "POST", credentials: "omit", headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: addr, client_key: signin.key })
        }).then(function (r) { return r.json(); }).then(function (b) {
          signin.challenge = String(b.challenge_id || "");
          if (!signin.challenge) { say("Sign-in could not start."); return; }
          email.hidden = true; code.hidden = false; go.textContent = "Sign in"; code.focus();
          say("If that address is invited, a six-digit code is on its way.");
        }).catch(function () { say("Sign-in could not start."); });
        return;
      }
      fetch(base + "/v1/auth/verify", {
        method: "POST", credentials: "omit", headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge_id: signin.challenge, email: signin.email,
                               code: String(code.value || "").trim(), client_key: signin.key })
      }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); }).then(function (x) {
        if (!x.ok || !x.b.token) { say("That code was not accepted."); return; }
        writeOperator(String(x.b.token), x.b.expires_at);
        ui.signin.hidden = true; signin.challenge = ""; code.value = "";
        start();
      }).catch(function () { say("Sign-in could not be completed."); });
    });

    /* --- speaking: one line at a time through the realtime session ------ */
    function speak(line, turn, kind) {
      if (!s || !line) return;
      if (kind === "build") s.builtTurn = Math.max(s.builtTurn, turn);
      s.queue.push({ text: line, turn: turn, kind: kind || "reply" });
      flush();
    }

    function flush() {
      if (!s || s.speaking || s.userTalking || !s.queue.length) return;
      if (!s.channel || s.channel.readyState !== "open") return;
      var next = s.queue.shift();
      // A reply to an earlier turn is stale once the visitor has moved on. What
      // the builder reports (built, or asking) waits for a pause instead.
      if (next.kind === "reply" && (next.turn < s.turn || next.turn <= s.floor)) { flush(); return; }
      var id = "vc-" + randomHex(8);
      s.speaking = { id: id, responseId: "" };
      try {
        s.channel.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user",
          content: [{ type: "input_text", text: "Say exactly this to the visitor, word for word, and nothing else: " + next.text }] } }));
        s.channel.send(JSON.stringify({ type: "response.create", response: { output_modalities: ["audio"], metadata: { vc: id } } }));
        say("Speaking");
      } catch (e) { s.speaking = null; }
    }

    function onChannel(ev) {
      var ticket = gen;
      var msg = parseJson(ev && ev.data);
      if (!s || ticket !== s.gen) return;
      if (msg.type === "input_audio_buffer.speech_started") {
        // Barge-in. Nothing answering an earlier turn is spoken from here on:
        // the queue is dropped, a reply still on its way is refused when it
        // lands (floor), and the line playing now is cancelled.
        s.queue = s.queue.filter(function (line) { return line.kind === "build"; });
        s.floor = s.turn;
        s.userTalking = true;
        if (s.speaking) {
          try { s.channel.send(JSON.stringify({ type: "response.cancel" })); } catch (e) {}
        }
        say("Listening");
        return;
      }
      if (msg.type === "input_audio_buffer.speech_stopped") {
        s.userTalking = false;
        flush();
        return;
      }
      if (msg.type === "response.created") {
        var created = msg.response || {};
        if (s.speaking && created.metadata && created.metadata.vc === s.speaking.id) s.speaking.responseId = created.id || "";
        return;
      }
      if (msg.type === "response.done") {
        var done = msg.response || {};
        if (s.speaking && (!s.speaking.responseId || done.id === s.speaking.responseId)) {
          s.speaking = null;
          say("Listening");
          flush();
        }
        return;
      }
      if (msg.type === "conversation.item.input_audio_transcription.completed") {
        var text = String(msg.transcript || "").trim();
        if (!text || s.heard[msg.item_id]) return;
        s.heard[msg.item_id] = true;
        s.turn += 1;
        var turn = s.turn;
        var history = s.history.slice(-8);
        s.history.push({ who: "you", text: text.slice(0, 600) });
        caption("you", text);
        if (canvas) canvas.heard(text, msg.item_id);
        say("Thinking");
        ask(ticket, { text: text.slice(0, 600), history: history, agent: s.agent, turn: turn }, true);
      }
    }

    function ask(ticket, body, retry) {
      post("/v1/session/" + encodeURIComponent(s.id) + "/talk", s.token, body)
        .then(function (r) {
          if (!s || ticket !== s.gen) return;
          if (r.status === 200 && r.body.reply) {
            var reply = String(r.body.reply);
            // The visitor has moved on - a newer turn, or talking again since
            // this turn. Not spoken, so not remembered as said either.
            if (r.body.turn !== s.turn || r.body.turn <= s.floor) return;
            // The builder already reported on this turn: a late acknowledgement
            // ("on it") after "built it" would be backwards.
            if (s.builtTurn >= r.body.turn) return;
            s.history.push({ who: body.agent, text: reply.slice(0, 600) });
            caption(body.agent, reply);
            speak(reply, body.turn);
          } else if (r.status === 410) {
            end("The conversation has ended.");
          } else if (r.status === 429 && retry && /every/.test(String(r.body.detail || ""))) {
            // Two utterances closer than the server spacing: try this one once
            // more. The stale checks above still apply to what comes back.
            setTimeout(function () { if (s && ticket === s.gen && body.turn === s.turn) ask(ticket, body, false); }, 1600);
          } else {
            say(r.status === 429 ? "This conversation has reached its limit." : "The agent could not answer that turn. Keep talking.");
          }
        }).catch(function () { if (s && ticket === s.gen) say("The agent could not answer that turn. Keep talking."); });
    }

    /* --- start / end ----------------------------------------------------- */
    function start() {
      if (s) return;
      var operator = readOperator();
      if (!operator) { ui.signin.hidden = false; email.hidden = false; code.hidden = true; go.textContent = "Send code"; email.focus(); say("Sign in with your invited email to talk."); return; }
      var media = navigator.mediaDevices;
      if (!media || typeof media.getUserMedia !== "function" || typeof window.RTCPeerConnection !== "function") {
        say("This browser cannot open a voice conversation."); return;
      }
      var ticket = ++gen;
      s = { gen: ticket, id: "", token: "", agent: ui.agent.value || "claude", turn: 0, history: [], heard: {},
            floor: 0, builtTurn: 0, queue: [], speaking: null, pc: null, channel: null, stream: null, timer: null };
      ui.start.hidden = true; ui.end.hidden = false; ui.agent.disabled = true;
      say("Starting");
      post("/v1/session", operator, { creation_id: randomHex(16), title: "Homepage conversation", start: "blank" })
        .then(function (r) {
          if (!s || ticket !== s.gen) {
            // Ended (or the page left) while the session was being created: that
            // session exists now, so stop it rather than leave it running
            // against the daily cap (Cursor NO-GO on 2a4cb8e).
            if (r.status === 200 && r.body.session_id && r.body.token) stopSession(String(r.body.session_id), String(r.body.token), 1);
            return null;
          }
          if (r.status === 401) { writeOperator("", ""); end(""); start(); return null; }
          if (r.status !== 200 || !r.body.session_id || !r.body.token) { end(r.status === 429 ? "The conversations for today are used up." : "The conversation could not start."); return null; }
          s.id = String(r.body.session_id); s.token = String(r.body.token);
          s.version = typeof r.body.artifact_version === "number" ? r.body.artifact_version : 1;
          ui.caption.textContent = ""; ui.caption.hidden = true;
          if (canvas) canvas.open({ id: s.id, token: s.token, version: s.version,
            generation: typeof r.body.generation === "number" ? r.body.generation : 0, analyst: analystOn });
          return media.getUserMedia({ audio: true });
        })
        .then(function (stream) {
          if (!stream) return null;
          if (!s || ticket !== s.gen) { stream.getTracks().forEach(function (t) { t.stop(); }); return null; }
          s.stream = stream;
          var pc = new RTCPeerConnection(); s.pc = pc;
          stream.getTracks().forEach(function (t) { pc.addTrack(t, stream); });
          var channel = pc.createDataChannel("oai-events"); s.channel = channel;
          channel.onmessage = onChannel;
          channel.onopen = function () { say("Listening"); flush(); };
          pc.ontrack = function (e) { if (e.streams && e.streams[0]) ui.audio.srcObject = e.streams[0]; };
          return pc.createOffer().then(function (offer) { return pc.setLocalDescription(offer); }).then(function () {
            if (pc.iceGatheringState === "complete") return pc.localDescription.sdp;
            return new Promise(function (resolve) {
              var t = setTimeout(function () { resolve(pc.localDescription.sdp); }, 3000);
              pc.addEventListener("icegatheringstatechange", function () {
                if (pc.iceGatheringState === "complete") { clearTimeout(t); resolve(pc.localDescription.sdp); }
              });
            });
          }).then(function (sdp) {
            if (!s || ticket !== s.gen) return null;
            return post("/v1/session/" + encodeURIComponent(s.id) + "/voice", s.token, { sdp: sdp });
          }).then(function (r) {
            if (!r || !s || ticket !== s.gen) return;
            if (r.status !== 200 || typeof r.body.sdp !== "string") {
              end(r.status === 429 ? "The voice conversations for today are used up." : "Voice could not start."); return;
            }
            return s.pc.setRemoteDescription({ type: "answer", sdp: r.body.sdp }).then(function () {
              if (typeof r.body.ends_at === "number") {
                s.timer = setTimeout(function () { end("The conversation reached its time limit."); },
                                     Math.max(0, r.body.ends_at * 1000 - Date.now()));
              }
            });
          });
        })
        .catch(function (err) {
          if (!s || ticket !== s.gen) return;
          end(err && err.name === "NotAllowedError" ? "Microphone access was blocked." : "The conversation could not start.");
        });
    }

    function stopSession(id, token, version) {
      return post("/v1/session/" + encodeURIComponent(id) + "/commands", token,
                  { command_id: "cmd-end-" + randomHex(4), session_id: id, type: "stop", expected_version: version || 1 })
        .catch(function () {});
    }

    function end(message) {
      var live = s;
      s = null; gen += 1;
      if (live) {
        if (live.timer) clearTimeout(live.timer);
        if (live.id && live.token) stopSession(live.id, live.token, live.version);
        try { if (live.channel) live.channel.close(); } catch (e) {}
        try { if (live.pc) live.pc.close(); } catch (e) {}
        if (live.stream) live.stream.getTracks().forEach(function (t) { t.stop(); });
      }
      if (canvas) canvas.close();
      ui.audio.srcObject = null;
      ui.start.hidden = false; ui.end.hidden = true; ui.agent.disabled = false;
      say(message == null ? "Conversation ended." : message);
    }

    ui.start.addEventListener("click", start);
    ui.end.addEventListener("click", function () { end("Conversation ended."); });
    window.addEventListener("pagehide", function () { if (s) end(""); });
    return { start: start, end: end };
  }

  window.SFDC24Voice = { mount: mount };
  function boot() {
    var root = document.getElementById("voice-conversation");
    if (root) mount(root, {});
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
