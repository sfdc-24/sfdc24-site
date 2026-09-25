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

  function writeOperator(token, expiresAt, scope) {
    try {
      sessionStorage.setItem(OPERATOR_KEY, JSON.stringify({ token: token, expires_at: expiresAt || "", scope: scope || "" }));
    } catch (e) {}
  }

  /* "client" for a signed-in client with a workspace; "" otherwise. */
  function readScope() {
    try { return String(parseJson(sessionStorage.getItem(OPERATOR_KEY) || "").scope || ""); } catch (e) { return ""; }
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
      // Said before the code is sent, so a visitor knows what signing in means.
      consent: el("p", { "class": "vc-consent", "data-vc-consent": "", hidden: "" },
                  "We keep your email and a recap of this conversation so SFDC24 can follow up."),
      caption: el("p", { "class": "vc-caption", "data-vc-caption": "", hidden: "" }),
      notes: el("section", { "class": "vc-notes", "data-vc-notes": "", "aria-label": "Meeting notes", hidden: "" }),
      // What is happening now, inside the phone's bottom bar during a conversation.
      live: el("span", { "class": "vc-live-status", "data-vc-live": "", "aria-hidden": "true" }),
      // After a conversation: how happy the visitor is, and the session as a PDF.
      endcard: el("section", { "class": "vc-endcard", "data-vc-endcard": "", "aria-label": "How did we do", hidden: "" }),
      audio: el("audio", { "data-vc-audio": "", autoplay: "" })
    };
    var email = el("input", { type: "email", "data-vc-email": "", autocomplete: "email", "aria-label": "Email" });
    var code = el("input", { type: "text", "data-vc-code": "", inputmode: "numeric", autocomplete: "one-time-code",
                             "aria-label": "Six-digit code", maxlength: "6", hidden: "" });
    var go = el("button", { type: "submit" }, "Send code");
    ui.signin.appendChild(email); ui.signin.appendChild(code); ui.signin.appendChild(go);
    var row = el("div", { "class": "vc-row" });
    row.appendChild(ui.live); row.appendChild(ui.start); row.appendChild(ui.agent); row.appendChild(ui.end);
    // Before Start: what the visitor wants to work on. It quietly picks the
    // templates, which agents lead and what the architect opens with; the
    // visitor never has to know which agent or model that means.
    var TOPICS = [["logo", "Design a logo"], ["website", "Build a website"], ["app", "Develop an app"],
                  ["salesforce_admin", "Salesforce admin"], ["salesforce_data", "Salesforce data"], ["other", "Something else"]];
    var topic = "";
    var topicRow = el("div", { "class": "vc-topics", "data-vc-topics": "", role: "radiogroup", "aria-label": "What are we working on?" });
    var topicButtons = TOPICS.map(function (t) {
      var b = el("button", { type: "button", role: "radio", "aria-checked": "false", "data-vc-topic": t[0] }, t[1]);
      b.addEventListener("click", function () {
        if (s) return;
        topic = topic === t[0] ? "" : t[0];
        topicButtons.forEach(function (o) { o.setAttribute("aria-checked", o.getAttribute("data-vc-topic") === topic ? "true" : "false"); });
      });
      topicRow.appendChild(b);
      return b;
    });
    // A signed-in client's workspace: their projects, each opened on the canvas
    // to change by talking, or something new (the topics and Start below).
    ui.workspace = el("section", { "class": "vc-workspace", "data-vc-workspace": "", "aria-label": "Your workspace", hidden: "" });
    root.appendChild(ui.workspace);
    root.appendChild(topicRow);
    root.appendChild(row); root.appendChild(ui.signin); root.appendChild(ui.consent); root.appendChild(ui.status);
    root.appendChild(ui.caption); root.appendChild(ui.notes); root.appendChild(ui.endcard); root.appendChild(ui.audio);
    var RATINGS = ["Not yet", "Somewhat", "Happy", "Very happy", "Thrilled"];
    var rateRow = el("div", { "class": "vc-rate", role: "radiogroup", "aria-label": "How happy are you with the outcome" });
    var rateButtons = RATINGS.map(function (label, i) {
      var b = el("button", { type: "button", role: "radio", "aria-checked": "false", "data-vc-rate": String(i + 1) }, label);
      rateRow.appendChild(b);
      return b;
    });
    var pdfButton = el("button", { type: "button", "class": "vc-pdf", "data-vc-pdf": "", hidden: "" },
                       "Email me the session as a PDF");
    var endNote = el("p", { "class": "vc-endnote", "data-vc-endnote": "", role: "status", hidden: "" });
    ui.endcard.appendChild(el("h4", {}, "How happy are you with what we built?"));
    ui.endcard.appendChild(rateRow); ui.endcard.appendChild(pdfButton); ui.endcard.appendChild(endNote);
    var notesList = el("ul", { "data-vc-notes-list": "" });
    ui.notes.appendChild(el("h4", {}, "Meeting notes"));
    ui.notes.appendChild(notesList);

    var s = null;          // the live conversation, or null
    var gen = 0;           // bumps on every start and end; late callbacks compare against it
    var signin = { challenge: "", key: "", email: "" };
    var LABELS = { you: "You", claude: "Claude", openai: "OpenAI", gemini: "Gemini", meta: "Llama",
                   host: "Host", muse: "Muse" };
    var routingOn = false;   // the controller picks the model from the topic (features.routing)

    // The live canvas (assets/prototype-canvas.js), when the page has one:
    // everything said is also sent to the builder, and what the builder
    // confirms or asks is spoken in this same call.
    var canvasRoot = document.getElementById("prototype-canvas");
    // Both voices, or neither: the host welcomes, notes and recaps only when the
    // architect is there too (the controller lists both in features.voices).
    var publicOn = false;
    var analystOn = false, twoVoices = false;
    var ratingOn = false, pdfOn = false;
    var advisorOn = false;   // the Gemini advisor's card (features.advisor)
    var museOn = false, museVoice = false;   // the Muse lane, and its own voice
    var ended = null;      // the last conversation, for the end card: { id, token }
    // Each agent introduces itself in its own voice, then hands the visitor the floor.
    var HOST_INTRO = "Hi, and welcome to SFDC24! I'm your host. I'll keep the notes while we talk, " +
                     "and when you're done I'll wrap it all up with a quick recap.";
    var ARCHITECT_INTRO = "And I'm your architect. Tell me what's on your mind: a logo, a website, an app, " +
                          "a problem to solve. I'll build it on the canvas while you talk. So, what are we making today?";
    var ARCHITECT_INTROS = {
      logo: "And I'm your architect. Let's design your logo. Tell me the name, the feeling you want, anything you " +
            "love or hate, and I'll sketch it on the canvas while you talk.",
      website: "And I'm your architect. Let's build your website. Tell me who it's for and what they should do " +
               "first, and I'll lay it out on the canvas while you talk.",
      app: "And I'm your architect. Let's shape your app. Tell me who uses it and the one thing it must do " +
           "brilliantly, and I'll draft the screens while you talk.",
      salesforce_admin: "And I'm your architect. Let's sort out your Salesforce setup. Tell me what's slowing " +
                        "your team down, and I'll map the fix on the canvas while you talk.",
      salesforce_data: "And I'm your architect. Let's get your Salesforce data working for you. Tell me what you " +
                       "track and what you wish you could see, and I'll model it while you talk."
    };
    var topicsOn = false;  // the controller takes the topic too (features.topics)
    var workspacesOn = false, pendingProject = null;
    ARCHITECT_INTROS.project = "And I'm your architect. Your page is on the canvas now. Tell me what you'd like to " +
                               "change, and I'll change it while you talk.";

    function note(label, text) {
      var li = el("li", {});
      if (label) li.appendChild(el("b", {}, label + ": "));
      li.appendChild(document.createTextNode(text));
      notesList.appendChild(li);
      while (notesList.children.length > 10) notesList.removeChild(notesList.firstChild);
      ui.notes.hidden = false;
    }
    var canvas = canvasRoot && window.SFDC24Canvas ? window.SFDC24Canvas.create(canvasRoot, {
      base: base,
      speak: function (line) { if (s) speak(line, s.turn, "build"); },
      museSay: function (line) { if (s) speak(line, s.turn, "muse"); },
      museHear: function (id) { if (s && museVoice) speak(id, s.turn, "hear"); }
    }) : null;

    function say(text) { ui.status.textContent = text || ""; ui.live.textContent = text || ""; }

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
      publicOn = !!f.public_visitors;
      ratingOn = !!f.rating;
      advisorOn = !!f.advisor;
      topicsOn = !!f.topics;
      workspacesOn = !!f.workspaces;
      if (workspacesOn && readScope() === "client" && readOperator()) loadWorkspace();
      pdfOn = !!f.summary_email;
      var voices = Array.isArray(f.voices) ? f.voices : [];
      twoVoices = voices.indexOf("host") >= 0 && voices.indexOf("architect") >= 0;
      museOn = !!f.muse;
      museVoice = museOn && voices.indexOf("muse") >= 0;
      // The conversation replaces the older in-browser microphone on the ask
      // bar: speech now goes to OpenAI, not to the browser recogniser.
      var old = document.getElementById("mic");
      if (old) { old.hidden = true; old.style.display = "none"; old.setAttribute("data-retired", "openai-voice"); }
      var agents = Array.isArray(f.agents) ? f.agents : [];
      ui.agent.textContent = "";
      agents.forEach(function (a) {
        var o = el("option", { value: a }, a === "claude" ? "Claude" : a === "openai" ? "OpenAI" : a);
        ui.agent.appendChild(o);
      });
      // The visitor never picks a model: with routing the controller chooses it
      // from the topic (owner, 2026-09-25); without it, the first one answers.
      routingOn = !!f.routing;
      ui.agent.hidden = true;
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
          say(publicOn ? "A six-digit code is on its way to " + addr + "."
                       : "If that address is invited, a six-digit code is on its way.");
        }).catch(function () { say("Sign-in could not start."); });
        return;
      }
      fetch(base + "/v1/auth/verify", {
        method: "POST", credentials: "omit", headers: { "content-type": "application/json" },
        body: JSON.stringify({ challenge_id: signin.challenge, email: signin.email,
                               code: String(code.value || "").trim(), client_key: signin.key })
      }).then(function (r) { return r.json().then(function (b) { return { ok: r.ok, b: b }; }); }).then(function (x) {
        if (!x.ok || !x.b.token) { say("That code was not accepted."); return; }
        writeOperator(String(x.b.token), x.b.expires_at, String(x.b.scope || ""));
        ui.signin.hidden = true; signin.challenge = ""; code.value = "";
        ui.consent.hidden = true;
        if (workspacesOn && x.b.scope === "client") {        // their workspace first, then they choose
          loadWorkspace();
          say("Signed in. Open one of your projects, or start something new.");
          return;
        }
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
      if ((next.kind === "build" || next.kind === "intro") && twoVoices) {
        if (next.kind === "build") note("Architect", next.text);
        playArchitect(next);
        return;
      }
      // A direction's sample line, in its tone: only the Muse's voice can say it.
      if (next.kind === "hear") {
        if (museVoice) playTts(next, { voice: "muse", direction: next.text });
        else flush();
        return;
      }
      if (next.kind === "muse") {
        if (twoVoices) note("Muse", next.text);
        caption("muse", next.text);
        if (museVoice) { playTts(next, { voice: "muse", text: next.text.slice(0, 400) }); return; }
      }
      sayRealtime(next);
    }

    /* The host speaks through the realtime call (marin). */
    function sayRealtime(next) {
      var id = "vc-" + randomHex(8);
      s.speaking = { id: id, responseId: "", kind: next.kind, text: next.text, generated: false, played: false,
                     started: false, guard: null };
      try {
        s.channel.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user",
          content: [{ type: "input_text", text: "Say exactly this to the visitor, word for word, and nothing else: " + next.text }] } }));
        s.channel.send(JSON.stringify({ type: "response.create", response: { output_modalities: ["audio"], metadata: { vc: id } } }));
        say("Speaking");
        // No response event at all in 20 s: the line is not coming. Any event
        // (response.done, output_audio_buffer.started) re-arms its guard.
        var pending = s.speaking;
        pending.guard = setTimeout(function () { release(pending); }, 20000);
      } catch (e) { s.speaking = null; }
    }

    /* The architect speaks in its own voice (OpenAI TTS through the
       controller). One line at a time, in the same queue as the host; a
       visitor who starts talking aborts the fetch and stops the audio. */
    function playArchitect(next) {
      playTts(next, { text: next.text.slice(0, 400), voice: "architect" });
    }

    /* A line in one of the controller's TTS voices (the architect, the Muse). */
    function playTts(next, body) {
      var ticket = s.gen;
      var ctrl = typeof AbortController === "function" ? new AbortController() : null;
      var line = { id: "vc-" + randomHex(8), tts: true, ctrl: ctrl, audio: null, url: "", kind: next.kind };
      s.speaking = line;
      say("Speaking");
      fetch(base + "/v1/session/" + encodeURIComponent(s.id) + "/speak", {
        method: "POST", credentials: "omit", cache: "no-store", signal: ctrl ? ctrl.signal : undefined,
        headers: { "authorization": "Bearer " + s.token, "content-type": "application/json" },
        body: JSON.stringify(body)
      }).then(function (r) { return r.ok ? r.blob() : null; }).then(function (blob) {
        if (!s || ticket !== s.gen || s.speaking !== line) return;
        if (!blob || !blob.size) {                 // no TTS voice: the host says it instead
          s.speaking = null;
          if (next.kind === "hear") { finished(line); return; }   // a preview's text is an id, never said
          sayRealtime(next);
          return;
        }
        line.url = URL.createObjectURL(blob);
        line.audio = new Audio(line.url);
        line.audio.onended = function () { release(line); };
        line.audio.onerror = function () { fallBack(line, next); };
        var played = line.audio.play();
        if (played && typeof played.catch === "function") played.catch(function () { fallBack(line, next); });
      }).catch(function () { fallBack(line, next); });
    }

    /* The architect could not say it (network, decode or playback): the host
       says the line instead, unless the visitor cut it off on purpose. */
    function fallBack(line, next) {
      if (line.cut || !s || s.speaking !== line) return;
      stopArchitect(line);
      s.speaking = null;
      if (next.kind === "hear") { finished(line); return; }
      sayRealtime(next);
    }

    function stopArchitect(line) {
      line.cut = true;
      if (line.ctrl) { try { line.ctrl.abort(); } catch (e) {} }
      if (line.audio) { try { line.audio.pause(); } catch (e) {} }
      if (line.url) { try { URL.revokeObjectURL(line.url); } catch (e) {} line.url = ""; }
    }

    /* The last resort for a realtime line whose end is never reported. If
       its audio reported starting, a stopped event is coming: wait up to two
       minutes. If it never did, allow a slow speaking rate for its words. */
    function armGuard(line) {
      if (line.guard) { clearTimeout(line.guard); line.guard = null; }
      if (!line.generated && !line.started) return;
      var words = String(line.text || "").split(/\s+/).length;
      var wait = line.started ? 120000 : Math.min(90000, 3000 + words * 600);
      line.guard = setTimeout(function () { release(line); }, wait);
    }

    function release(line) {
      if (line.guard) { clearTimeout(line.guard); line.guard = null; }
      if (line.tts) stopArchitect(line);
      if (!s || s.speaking !== line) return;
      s.speaking = null;
      finished(line);
    }

    /* After any line: the recap is the last thing said before hanging up. */
    function finished(line) {
      if (line.kind === "recap" && s && s.wrapping) {
        var ticket = s.gen;
        if (s.wrapTimer) clearTimeout(s.wrapTimer);
        s.wrapTimer = setTimeout(function () { if (s && ticket === s.gen && s.wrapping) end("Conversation ended."); }, 600);
        return;
      }
      say("Listening");
      flush();
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
        if (s.speaking && s.speaking.tts) {
          stopArchitect(s.speaking);               // Gemini: no ghost audio after a barge-in
          s.speaking = null;
        } else if (s.speaking) {
          try { s.channel.send(JSON.stringify({ type: "response.cancel" })); } catch (e) {}
        }
        if (s.wrapping) {                          // talking during the recap means keep going
          s.wrapping = false;
          if (s.wrapTimer) clearTimeout(s.wrapTimer);
          s.queue = s.queue.filter(function (line) { return line.kind !== "recap"; });
          ui.end.textContent = "End conversation";
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
      // A realtime line is over when its AUDIO has played, not when the model
      // has finished generating it: over WebRTC, response.done arrives while
      // the words are still coming out of the speaker, and releasing the next
      // line then put two voices on top of each other (owner, 2026-09-25).
      if (msg.type === "response.done") {
        var done = msg.response || {};
        if (s.speaking && !s.speaking.tts && (!s.speaking.responseId || done.id === s.speaking.responseId)) {
          var line = s.speaking;
          line.generated = true;
          if (line.played || done.status === "cancelled" || done.status === "failed") release(line);
          else armGuard(line);
        }
        return;
      }
      if (msg.type === "output_audio_buffer.started") {
        // The session reports this line's audio: from here only "stopped" ends
        // it, however long it runs (Cursor NO-GO on 72e5765: a word-count
        // timer beat "stopped" on a long reply or recap).
        var begun = s.speaking;
        if (begun && !begun.tts && (!begun.responseId || !msg.response_id || msg.response_id === begun.responseId)) {
          begun.started = true;
          armGuard(begun);
        }
        return;
      }
      if (msg.type === "output_audio_buffer.stopped" || msg.type === "output_audio_buffer.cleared") {
        var playing = s.speaking;
        if (playing && !playing.tts && (!playing.responseId || !msg.response_id || msg.response_id === playing.responseId)) {
          playing.played = true;
          if (playing.generated || msg.type === "output_audio_buffer.cleared") release(playing);
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
        var said = { text: text.slice(0, 600), history: history, turn: turn };
        if (s.agent) said.agent = s.agent;           // with routing the controller picks from the topic
        ask(ticket, said, true);
      }
    }

    function ask(ticket, body, retry) {
      post("/v1/session/" + encodeURIComponent(s.id) + "/talk", s.token, body)
        .then(function (r) {
          if (!s || ticket !== s.gen) return;
          if (r.status === 200 && r.body.reply) {
            var reply = String(r.body.reply);
            // The use policy ended the session (the controller has already hung
            // up the call): show why, in its words, whatever turn this was.
            if (r.body.ended) { end(reply); return; }
            // The visitor has moved on - a newer turn, or talking again since
            // this turn. Not spoken, so not remembered as said either.
            if (r.body.turn !== s.turn || r.body.turn <= s.floor) return;
            // The builder already reported on this turn: a late acknowledgement
            // ("on it") after "built it" would be backwards.
            if (s.builtTurn >= r.body.turn) return;
            var who = LABELS[r.body.speaker] ? String(r.body.speaker) : (body.agent || "claude");
            s.history.push({ who: who, text: reply.slice(0, 600) });
            caption(who, reply);
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

    /* --- a client's workspace ------------------------------------------- */
    function loadWorkspace() {
      var token = readOperator();
      if (!token) return;
      fetch(base + "/v1/workspace", { credentials: "omit", cache: "no-store",
        headers: { "authorization": "Bearer " + token, "accept": "application/json" } })
        .then(function (r) { return r.text().then(function (t) { return { status: r.status, body: parseJson(t) }; }); })
        .then(function (r) {
          if (r.status === 401) { writeOperator("", ""); ui.workspace.hidden = true; return; }
          if (r.status !== 200) return;
          showWorkspace(r.body);
        }).catch(function () {});
    }

    function showWorkspace(w) {
      ui.workspace.textContent = "";
      var name = String(w.name || "").trim();
      ui.workspace.appendChild(el("h3", {}, name ? "Welcome back, " + name + "." : "Welcome back."));
      ui.workspace.appendChild(el("p", { "class": "vc-workspace-sub" },
        "Open one of your projects and talk through what you want changed, or start something new below."));
      var list = el("div", { "class": "vc-projects" });
      (Array.isArray(w.projects) ? w.projects : []).slice(0, 12).forEach(function (p) {
        var id = String((p && p.id) || "");
        if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(id)) return;
        var card = el("div", { "class": "vc-project", "data-vc-project-card": id });
        card.appendChild(el("b", {}, String(p.name || id)));
        var open = el("button", { type: "button", "data-vc-project": id }, "Open and talk it through");
        open.addEventListener("click", function () {
          if (s) return;
          pendingProject = { id: id, name: String(p.name || id) };
          start();
        });
        card.appendChild(open);
        list.appendChild(card);
      });
      ui.workspace.appendChild(list);
      ui.workspace.hidden = false;
    }

    /* --- start / end ----------------------------------------------------- */
    function start() {
      if (s) return;
      var operator = readOperator();
      if (!operator) {
        ui.signin.hidden = false; email.hidden = false; code.hidden = true; go.textContent = "Send code";
        ui.consent.hidden = !publicOn;
        email.focus();
        say(publicOn ? "Enter your email to start. We will send you a six-digit code."
                     : "Sign in with your invited email to talk.");
        return;
      }
      var media = navigator.mediaDevices;
      if (!media || typeof media.getUserMedia !== "function" || typeof window.RTCPeerConnection !== "function") {
        say("This browser cannot open a voice conversation."); return;
      }
      var ticket = ++gen, sid = "", stoken = "";
      var project = pendingProject; pendingProject = null;
      s = { gen: ticket, id: "", token: "", agent: routingOn ? "" : (ui.agent.value || "claude"), topic: project ? "project" : topic,
            project: project, turn: 0, history: [], heard: {},
            floor: 0, builtTurn: 0, queue: [], speaking: null, pc: null, channel: null, stream: null, timer: null };
      ui.start.hidden = true; ui.end.hidden = false; ui.agent.disabled = true;
      ui.endcard.hidden = true; ended = null;
      root.classList.add("vc-live"); document.body.classList.add("vc-live-on");
      say("Starting");
      var create = project
        ? { creation_id: randomHex(16), title: project.name, start: "project", project: project.id }
        : { creation_id: randomHex(16), title: "Homepage conversation", start: "blank" };
      if (!project && topicsOn && s.topic) create.topic = s.topic;
      post("/v1/session", operator, create)
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
          notesList.textContent = ""; ui.notes.hidden = true;
          if (canvas) canvas.open({ id: s.id, token: s.token, version: s.version,
            generation: typeof r.body.generation === "number" ? r.body.generation : 0, analyst: analystOn,
            muse: museOn, hear: museVoice, topic: s.topic, advisor: advisorOn });
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
          channel.onopen = function () {
            say("Listening");
            if (twoVoices && !s.welcomed) {
              s.welcomed = true;
              speak(HOST_INTRO, 0, "host");
              speak(ARCHITECT_INTROS[s.topic] || ARCHITECT_INTRO, 0, "intro");
            }
            flush();
          };
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
            sid = s.id; stoken = s.token;
            return post("/v1/session/" + encodeURIComponent(s.id) + "/voice", s.token, { sdp: sdp });
          }).then(function (r) {
            if (!r) return;
            if (!s || ticket !== s.gen) {
              // Ended while the call was being opened. The stop sent by End ran
              // before the controller stored this call, so it could not hang it
              // up; stop again now that it exists (Cursor NO-GO on db5503e).
              if (r.status === 200) stopSession(sid, stoken, 1);
              return;
            }
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

    function wrapUp() {
      var ticket = s.gen;
      s.wrapping = true;
      ui.end.textContent = "End now";
      say("Wrapping up");
      post("/v1/session/" + encodeURIComponent(s.id) + "/recap", s.token, s.agent ? { agent: s.agent } : {}).then(function (r) {
        if (!s || ticket !== s.gen || !s.wrapping) return;
        if (r.status !== 200 || !r.body.recap) { end("Conversation ended."); return; }
        var recap = String(r.body.recap);
        note("Recap", recap);
        caption("host", recap);
        s.queue = [];
        speak(recap, s.turn, "recap");
        // While anything is being said - the recap, or the line it waits
        // behind - the wrap-up waits: every line has its own end (stopped, a
        // TTS clip ending, or a line's last-resort guard), and the recap's end
        // hangs up. Only a wrap-up with nothing left speaking, or one still
        // going after five minutes, is ended here (Cursor NO-GO on a26c777 and
        // 59b724a: a long line or a recap about to start was cut off).
        var wrapFrom = Date.now();
        s.wrapTimer = setTimeout(function wrapCheck() {
          if (!s || ticket !== s.gen || !s.wrapping) return;
          if (s.speaking && Date.now() - wrapFrom < 300000) {
            s.wrapTimer = setTimeout(wrapCheck, 5000);
            return;
          }
          end("Conversation ended.");
        }, 45000);
      }).catch(function () { if (s && ticket === s.gen) end("Conversation ended."); });
    }

    function end(message) {
      var live = s;
      s = null; gen += 1;
      ui.end.textContent = "End conversation";
      if (live) {
        if (live.timer) clearTimeout(live.timer);
        if (live.wrapTimer) clearTimeout(live.wrapTimer);
        if (live.speaking && live.speaking.tts) stopArchitect(live.speaking);
        if (live.id && live.token) stopSession(live.id, live.token, live.version);
        try { if (live.channel) live.channel.close(); } catch (e) {}
        try { if (live.pc) live.pc.close(); } catch (e) {}
        if (live.stream) live.stream.getTracks().forEach(function (t) { t.stop(); });
      }
      if (canvas) canvas.close();
      ui.audio.srcObject = null;
      ui.start.hidden = false; ui.end.hidden = true; ui.agent.disabled = false;
      root.classList.remove("vc-live"); document.body.classList.remove("vc-live-on");
      say(message == null ? "Conversation ended." : message);
      if (live && live.id && live.token && live.turn > 0 && (ratingOn || pdfOn)) showEndCard(live);
    }

    /* --- the end card: how happy they are, and the session as a PDF ------ */
    function showEndCard(live) {
      ended = { id: live.id, token: live.token };
      rateButtons.forEach(function (b) { b.setAttribute("aria-checked", "false"); });
      rateRow.hidden = !ratingOn;
      ui.endcard.querySelector("h4").textContent = ratingOn ? "How happy are you with what we built?"
                                                             : "Take the session with you";
      pdfButton.hidden = !pdfOn; pdfButton.disabled = false;
      endNote.hidden = true; endNote.textContent = "";
      ui.endcard.hidden = false;
    }

    function endNoteSay(text) { endNote.textContent = text; endNote.hidden = false; }

    rateButtons.forEach(function (b) {
      b.addEventListener("click", function () {
        if (!ended) return;
        var score = Number(b.getAttribute("data-vc-rate"));
        var mine = ended;
        rateButtons.forEach(function (o) { o.setAttribute("aria-checked", o === b ? "true" : "false"); });
        post("/v1/session/" + encodeURIComponent(mine.id) + "/rating", mine.token, { score: score }).then(function (r) {
          if (ended !== mine) return;
          endNoteSay(r.status === 200 ? "Thank you. That helps us build the next one better."
                                      : "Your rating could not be saved right now.");
        }).catch(function () { if (ended === mine) endNoteSay("Your rating could not be saved right now."); });
      });
    });

    pdfButton.addEventListener("click", function () {
      if (!ended) return;
      var mine = ended;
      var body = {};
      var png = canvas && typeof canvas.snapshot === "function" ? canvas.snapshot() : "";
      if (png && png.length < 1900000) body.design_png = png;
      pdfButton.disabled = true;
      endNoteSay("Preparing your PDF.");
      post("/v1/session/" + encodeURIComponent(mine.id) + "/summary", mine.token, body).then(function (r) {
        if (ended !== mine) return;
        if (r.status === 200 && r.body.sent) { endNoteSay("Sent to " + String(r.body.to || "your email") + "."); return; }
        // The controller never sends a session's PDF twice: when it cannot be
        // sure an earlier try failed, it says so rather than risk a duplicate.
        if (/may already have been sent/.test(String(r.body.detail || ""))) {
          endNoteSay("Your PDF may already be on its way. Check your inbox.");
          return;
        }
        pdfButton.disabled = false;
        endNoteSay("The PDF could not be sent right now.");
      }).catch(function () { if (ended === mine) { pdfButton.disabled = false; endNoteSay("The PDF could not be sent right now."); } });
    });

    ui.start.addEventListener("click", start);
    ui.end.addEventListener("click", function () {
      // The first End asks the host to recap the meeting and then hangs up; a
      // second End (or one before anything was said) ends at once.
      if (s && twoVoices && s.turn > 0 && !s.wrapping && s.id) wrapUp();
      else end("Conversation ended.");
    });
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
