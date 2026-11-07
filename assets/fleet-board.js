/* Public fleet board.
 *
 * Reads only GET /data/fleet-public.json on this origin. That file is a
 * public-safe projection (schema sfdc24.fleet-public.v1). It is not the
 * withheld /data/xp-live.json keyspace, and this script never opens Redis,
 * the studio controller, or any other host.
 *
 * public_status "unpublished" means no publisher is attached. The board
 * looks again once a minute so a later projection appears without a reload,
 * and it does not call that wait a live feed. public_status "live" with
 * transport "poll" refreshes on the file's own poll_seconds (5 to 30).
 * transport "sse" listens only on /data/fleet-public.sse.
 *
 * A missing pulse is unknown, not idle. Feed age and a blocked task are
 * separate. Text is rendered with textContent.
 */
(function (root) {
  "use strict";

  var FEED_PATH = "/data/fleet-public.json";
  var SSE_PATH = "/data/fleet-public.sse";
  var RECHECK_MS = 60000;
  var RETRY_MS = 15000;
  var POLL_MIN = 5;
  var POLL_MAX = 30;
  var DEFAULT_FRESH = 300;
  var TEXT_MAX = 80;
  var ROSTER = [
    { id: "grok", name: "Grok" },
    { id: "claude", name: "Claude" },
    { id: "gemini", name: "Gemini" },
    { id: "copilot", name: "Copilot" },
    { id: "cursor", name: "Cursor" },
    { id: "aya", name: "Aya" }
  ];
  var STATUSES = { active: 1, idle: 1, blocked: 1, unknown: 1 };
  var OWNERS = { Grok: 1, Claude: 1, Gemini: 1, Copilot: 1, Cursor: 1, Aya: 1 };
  var SECRET_RE = /ghp_|github_pat_|gho_|glpat-|sk-|xox[baprs]-|AKIA|BEGIN |-----|\b(password|secret|token|bearer)\b/i;
  var EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  var PHONE_RE = /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/;
  var KEY_RE = /fleet:|v1:agent|v1:bus|redis:\/\/|inbox/i;
  var TEXT_RE = /[^A-Za-z0-9 .,'’:+\-\/()#]/g;

  function rosterIds() {
    var map = {};
    ROSTER.forEach(function (row) { map[row.id] = row.name; });
    return map;
  }

  function parseIso(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return null;
    var ms = Date.parse(value);
    return isFinite(ms) ? ms : null;
  }

  function publicText(value) {
    if (value == null) return { kind: "empty" };
    var text = String(value).replace(/\s+/g, " ").trim();
    if (!text) return { kind: "empty" };
    if (/[<>]/.test(text) || EMAIL_RE.test(text) || PHONE_RE.test(text) || SECRET_RE.test(text) || KEY_RE.test(text)) {
      return { kind: "withheld" };
    }
    text = text.replace(TEXT_RE, "").replace(/\s+/g, " ").trim();
    if (!text) return { kind: "withheld" };
    if (text.length > TEXT_MAX) text = text.slice(0, TEXT_MAX).trim();
    return { kind: "ok", text: text };
  }

  function labelFor(parsed, emptyLabel) {
    if (parsed.kind === "ok") return parsed.text;
    if (parsed.kind === "withheld") return "Not shown";
    return emptyLabel;
  }

  function formatWhen(ms) {
    if (ms == null) return "";
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone: "America/Toronto",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZoneName: "short"
      }).format(new Date(ms)).replace(/\u202f|\u00a0/g, " ");
    } catch (e) {
      return new Date(ms).toISOString();
    }
  }

  function freshWindow(raw) {
    var n = Number(raw && raw.fresh_within_sec);
    if (!isFinite(n) || n < 30 || n > 3600) return DEFAULT_FRESH;
    return Math.round(n);
  }

  function pollSeconds(raw) {
    var n = Number(raw && raw.poll_seconds);
    if (!isFinite(n)) return 15;
    if (n < POLL_MIN) return POLL_MIN;
    if (n > POLL_MAX) return POLL_MAX;
    return Math.round(n);
  }

  var PUBLIC_NAME = {
    grok: "Greg", greg: "Greg",
    claude: "Clay", clay: "Clay",
    gemini: "Jemma", jemma: "Jemma",
    copilot: "Copilot", cursor: "Cursor", aya: "Aya",
    owner: "Owner"
  };

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function taskEvidence(row) {
    if (!hasOwn(row, "task")) return { state: "absent" };
    var parsed = publicText(row.task);
    if (parsed.kind === "ok") return { state: "shown", text: parsed.text };
    if (parsed.kind === "withheld") return { state: "withheld" };
    return { state: "unreported" };
  }

  function waitingEvidence(row) {
    if (!hasOwn(row, "waiting_on")) return { state: "absent" };
    if (row.waiting_on == null || String(row.waiting_on).trim() === "") return { state: "unreported" };
    var parsed = publicText(row.waiting_on);
    if (parsed.kind !== "ok") return { state: "withheld" };
    var named = PUBLIC_NAME[parsed.text.toLowerCase()];
    if (!named) return { state: "withheld" };
    return { state: "named", name: named };
  }

  function blankAgent(row) {
    return {
      id: row.id,
      name: row.name,
      status: "unknown",
      blocked: false,
      pulseState: "none",
      pulseLabel: "No pulse",
      taskLabel: "Not reported",
      ownerLabel: "Not reported",
      gapLabel: "Not reported",
      taskEvidence: { state: "absent" },
      waiting: { state: "absent" }
    };
  }

  function readAgents(raw, readAt, freshSec) {
    var names = rosterIds();
    var byId = {};
    var list = raw && Array.isArray(raw.agents) ? raw.agents : [];
    list.forEach(function (row) {
      if (!row || typeof row !== "object" || Array.isArray(row)) return;
      var id = String(row.id || "").trim().toLowerCase();
      if (!names[id]) return;
      var explicit = String(row.status || "").trim().toLowerCase();
      var status = STATUSES[explicit] ? explicit : "unknown";
      var pulse = parseIso(row.pulse_at);
      var pulseState = "none";
      var pulseLabel = "No pulse";
      if (row.pulse_at != null && String(row.pulse_at).trim() !== "" && pulse == null) {
        pulseState = "unknown";
        pulseLabel = "Pulse time not usable";
      } else if (pulse != null && readAt != null) {
        var age = Math.round((readAt - pulse) / 1000);
        if (age < -60) {
          pulseState = "unknown";
          pulseLabel = "Pulse time not usable";
        } else if (age > freshSec) {
          pulseState = "stale";
          pulseLabel = formatWhen(pulse) + " · pulse stale";
        } else {
          pulseState = "fresh";
          pulseLabel = formatWhen(pulse);
        }
      } else if (pulse != null) {
        pulseState = "unknown";
        pulseLabel = formatWhen(pulse);
      }
      /* A name on the roster, or the word active without a fresh pulse, is
         not a connection. Active is shown only with an explicit status and a
         pulse inside the freshness window. */
      if (status === "active" && pulseState !== "fresh") status = "unknown";
      var owner = publicText(row.owner);
      var ownerLabel = labelFor(owner, "Not reported");
      if (owner.kind === "ok" && !OWNERS[owner.text]) ownerLabel = "Not shown";
      byId[id] = {
        id: id,
        name: names[id],
        status: status,
        blocked: status === "blocked",
        pulseState: pulseState,
        pulseLabel: pulseLabel,
        taskLabel: labelFor(publicText(row.task), "Not reported"),
        ownerLabel: ownerLabel,
        gapLabel: labelFor(publicText(row.gap), "Not reported"),
        taskEvidence: taskEvidence(row),
        waiting: waitingEvidence(row)
      };
    });
    return ROSTER.map(function (row) { return byId[row.id] || blankAgent(row); });
  }

  function unknowns() {
    return ROSTER.map(blankAgent);
  }

  function classify(raw, nowMs) {
    var now = typeof nowMs === "number" ? nowMs : Date.now();
    var feed = {
      state: "offline",
      label: "Offline",
      note: "The public fleet feed did not load. Missing pulses are unknown, not idle.",
      readAt: null,
      ageSec: null,
      scheduleMs: RETRY_MS,
      sse: false,
      live: false
    };
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || raw.schema !== "sfdc24.fleet-public.v1") {
      feed.note = "The public fleet file is not a usable projection. Status stays unknown.";
      return { feed: feed, agents: unknowns() };
    }
    var status = raw.public_status;
    var readAt = parseIso(raw.read_at);
    var freshSec = freshWindow(raw);
    if (status === "unpublished" || status === "withheld" || status == null || status === "") {
      feed.state = status === "withheld" ? "withheld" : "unpublished";
      feed.label = status === "withheld" ? "Withheld" : "Not published";
      feed.live = false;
      feed.scheduleMs = RECHECK_MS;
      feed.note = feed.state === "withheld"
        ? "This projection is withheld. No agent status is shown. The page looks again in 60 seconds. This is not a live feed."
        : "A public fleet feed is not published yet. No agent status is shown. The page looks again in 60 seconds. This is not a live feed.";
      return { feed: feed, agents: unknowns() };
    }
    if (status !== "live") {
      feed.state = "unpublished";
      feed.label = "Not published";
      feed.scheduleMs = RECHECK_MS;
      feed.note = "The public file is not a live projection. Status stays unknown. The page looks again in 60 seconds.";
      return { feed: feed, agents: unknowns() };
    }
    var transport = raw.transport === "sse" ? "sse" : (raw.transport === "poll" ? "poll" : "");
    if (!transport) {
      feed.state = "unpublished";
      feed.label = "No update channel";
      feed.scheduleMs = RECHECK_MS;
      feed.note = "The projection does not name a supported update channel. It is not treated as live.";
      return { feed: feed, agents: unknowns() };
    }
    var age = readAt == null ? null : Math.round((now - readAt) / 1000);
    var stale = readAt == null || age > freshSec || age < -60;
    feed.readAt = readAt;
    feed.ageSec = age;
    feed.sse = transport === "sse" && raw.sse_path === SSE_PATH;
    if (transport === "sse" && !feed.sse) {
      feed.state = "unpublished";
      feed.label = "No update channel";
      feed.scheduleMs = RECHECK_MS;
      feed.note = "The projection named an update channel this page does not use. Status stays unknown.";
      return { feed: feed, agents: unknowns() };
    }
    var every = pollSeconds(raw);
    feed.scheduleMs = feed.sse ? 0 : every * 1000;
    feed.live = !stale;
    if (stale) {
      feed.state = "stale";
      feed.label = "Feed stale";
      feed.note = "The projection is older than " + freshSec + " seconds. A blocked task stays blocked. This is not a fresh pulse.";
    } else {
      feed.state = "live";
      feed.label = "Live";
      feed.note = feed.sse
        ? "Live public projection over a same-origin event stream."
        : "Live public projection. Asks again every " + every + " seconds.";
    }
    if (readAt != null) feed.note += " Read " + formatWhen(readAt) + ".";
    feed.whatsapp = whatsappStatus(raw, feed.live);
    feed.conference = channelStatus(raw, "conference_status", "conference", feed.live);
    return { feed: feed, agents: readAgents(raw, readAt, freshSec) };
  }

  function channelStatus(raw, key, source, fresh) {
    if (!fresh || !raw || !hasOwn(raw, key) || !raw[key] || typeof raw[key] !== "object") return { state: "absent" };
    var item = raw[key];
    if (item.source !== source || !hasOwn(item, "text") || !hasOwn(item, "at")) return { state: "incomplete" };
    var when = parseIso(item.at);
    if (!when) return { state: "incomplete" };
    var parsed = publicText(item.text);
    if (parsed.kind === "withheld") return { state: "withheld" };
    if (parsed.kind !== "ok") return { state: "incomplete" };
    return { state: "shown", text: parsed.text, at: when };
  }

  function whatsappStatus(raw, fresh) {
    return channelStatus(raw, "whatsapp_status", "whatsapp", fresh);
  }

  function feedLine(view) {
    var state = view.feed.state;
    if (state === "live" && view.feed.live) return "Process illustration · live";
    if (state === "stale") return "Process illustration · feed stale";
    if (state === "offline") return "Process illustration · offline";
    if (state === "withheld") return "Process illustration · withheld";
    return "Process illustration · live status unavailable";
  }

  function syncMotion(host) {
    var draw = host.querySelector(".fb-draw");
    if (!draw || !draw.pauseAnimations) return;
    var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var pause = reduce || host.classList.contains("is-off") || host.classList.contains("is-paused");
    if (pause) draw.pauseAnimations();
    else draw.unpauseAnimations();
  }

  function render(host, view) {
    var feed = host.querySelector("[data-fb='feed']");
    if (!feed) return;
    var fresh = view.feed.state === "live" && view.feed.live === true;
    host.setAttribute("data-feed-state", view.feed.state);
    host.setAttribute("data-feed-live", fresh ? "1" : "0");
    feed.textContent = feedLine(view);
    var byId = {};
    view.agents.forEach(function (agent) { byId[agent.id] = agent; });
    var nodes = host.querySelectorAll(".fb-node");
    Array.prototype.forEach.call(nodes, function (node) {
      var id = node.getAttribute("data-agent");
      var agent = byId[id];
      var show = fresh && agent && agent.status && agent.status !== "unknown";
      node.classList.toggle("has-status", !!show);
      if (show && agent.blocked) node.setAttribute("data-blocked", "1");
      else node.removeAttribute("data-blocked");
      var live = node.querySelector("[data-field='status']");
      if (live) live.textContent = show ? agent.status.charAt(0).toUpperCase() + agent.status.slice(1) : "";
      var dot = node.querySelector(".fb-dot");
      if (dot) dot.hidden = !show;
    });
  }

  function boot() {
    var host = document.getElementById("fleet-board");
    if (!host || host.getAttribute("data-fleet-booted") === "1") return;
    host.setAttribute("data-fleet-booted", "1");
    var last = null;
    var timer = 0;
    var source = null;
    var current = { feed: { state: "offline", label: "Offline", note: "Reading the public fleet file.", live: false }, agents: unknowns() };

    function paint(view, keepAgents) {
      var next = view;
      if (keepAgents && last) {
        next = {
          feed: {
            state: view.feed.state,
            label: view.feed.label,
            note: "Offline. Showing the last public projection, not a new pulse. A blocked task stays blocked.",
            live: false
          },
          agents: last.agents
        };
      }
      current = next;
      render(host, next);
      if (picked) fillBoard(picked.kind, picked.id);
    }

    function stopSse() {
      if (source) {
        source.close();
        source = null;
      }
    }

    function arm(ms) {
      if (timer) clearInterval(timer);
      timer = 0;
      if (!ms) return;
      timer = setInterval(tick, ms);
    }

    function openSse() {
      try {
        source = new EventSource(SSE_PATH);
      } catch (e) {
        var failedOpen = classify(null, Date.now());
        paint(failedOpen, !!last);
        arm(RETRY_MS);
        return;
      }
      source.onmessage = function (ev) {
        var parsed = null;
        try { parsed = JSON.parse(ev.data); } catch (err) { parsed = null; }
        if (!parsed) return;
        var view = classify(parsed, Date.now());
        if (view.feed.live || view.feed.state === "stale") last = view;
        paint(view, false);
      };
      source.onerror = function () {
        stopSse();
        var failed = classify(null, Date.now());
        paint(failed, !!last);
        arm(RETRY_MS);
      };
    }

    function applyRaw(raw, nowMs) {
      var view = classify(raw, nowMs);
      if (view.feed.live || view.feed.state === "stale") last = view;
      paint(view, view.feed.state === "offline" && !!last);
      stopSse();
      if (view.feed.sse && (view.feed.state === "live" || view.feed.state === "stale")) {
        arm(0);
        openSse();
        return;
      }
      arm(view.feed.scheduleMs);
    }

    function tick() {
      var url = FEED_PATH + "?t=" + Date.now();
      fetch(url, { cache: "no-store", credentials: "omit" }).then(function (res) {
        if (!res.ok) throw new Error("status");
        return res.json();
      }).then(function (raw) {
        applyRaw(raw, Date.now());
      }).catch(function () {
        var failed = classify(null, Date.now());
        paint(failed, !!last);
        arm(RETRY_MS);
      });
    }

    var picked = null;
    var pinned = false;

    function shownTask(agent, fresh) {
      if (!fresh || !agent || !agent.taskEvidence) return "Unavailable";
      if (agent.taskEvidence.state === "shown") return agent.taskEvidence.text;
      if (agent.taskEvidence.state === "withheld") return "Not shown";
      return "Unavailable";
    }

    function shownWait(agent, fresh) {
      if (!fresh || !agent || !agent.waiting) return "Unavailable";
      if (agent.waiting.state === "named") return agent.waiting.name;
      if (agent.waiting.state === "withheld") return "Not shown";
      return "Unavailable";
    }

    function fillBoard(kind, id) {
      var panel = host.querySelector("[data-fb='board']");
      var node = kind === "human" ? host.querySelector("[data-human='owner']") : host.querySelector('[data-agent="' + id + '"]');
      if (!panel || !node) return;
      panel.hidden = false;
      host.querySelector("[data-fb='who']").textContent = node.querySelector("b").textContent;
      host.querySelector("[data-fb='role']").textContent = node.querySelector(".fb-role").textContent;
      var fresh = current.feed.state === "live" && current.feed.live === true;
      var routes = host.querySelector("[data-fb='routes']");
      var asof = host.querySelector("[data-fb='asof']");
      var taskRow = host.querySelector("[data-fb='task']").parentNode;
      var waitRow = host.querySelector("[data-fb='wait']").parentNode;
      if (kind === "human") {
        taskRow.hidden = true;
        waitRow.hidden = true;
        routes.hidden = false;
        var wa = current.feed.whatsapp;
        var conf = current.feed.conference;
        var note = "Drawn both ways, for updates and direction. ";
        if (fresh && wa && wa.state === "shown") note += "WhatsApp status, " + formatWhen(wa.at) + ": " + wa.text + ". ";
        else if (fresh && wa && wa.state === "withheld") note += "WhatsApp status not shown. ";
        else note += "WhatsApp status unavailable. ";
        if (fresh && conf && conf.state === "shown") note += "Conference status, " + formatWhen(conf.at) + ": " + conf.text + ".";
        else if (fresh && conf && conf.state === "withheld") note += "Conference status not shown.";
        else note += "Conference status unavailable.";
        routes.textContent = note;
      } else {
        taskRow.hidden = false;
        waitRow.hidden = false;
        var agent = null;
        current.agents.forEach(function (item) { if (item.id === id) agent = item; });
        host.querySelector("[data-fb='task']").textContent = shownTask(agent, fresh);
        host.querySelector("[data-fb='wait']").textContent = shownWait(agent, fresh);
        routes.hidden = true;
        routes.textContent = "";
      }
      asof.textContent = fresh && current.feed.readAt ? "As of " + formatWhen(current.feed.readAt) : "";
      Array.prototype.forEach.call(host.querySelectorAll(".fb-node, .fb-human"), function (el) {
        el.setAttribute("aria-pressed", el === node ? "true" : "false");
      });
    }

    function closeBoard() {
      pinned = false;
      picked = null;
      var panel = host.querySelector("[data-fb='board']");
      if (panel) panel.hidden = true;
      Array.prototype.forEach.call(host.querySelectorAll(".fb-node, .fb-human"), function (el) {
        el.setAttribute("aria-pressed", "false");
      });
    }

    function choose(node, pin) {
      if (pin) pinned = true;
      picked = {
        kind: node.getAttribute("data-human") ? "human" : "agent",
        id: node.getAttribute("data-human") ? "owner" : node.getAttribute("data-agent")
      };
      fillBoard(picked.kind, picked.id);
    }

    Array.prototype.forEach.call(host.querySelectorAll(".fb-node, .fb-human"), function (node) {
      if (!node.getAttribute("role")) node.setAttribute("role", "button");
      if (!node.hasAttribute("tabindex")) node.tabIndex = 0;
      node.addEventListener("mouseenter", function () { if (!pinned) choose(node, false); });
      node.addEventListener("mouseleave", function () { if (!pinned) closeBoard(); });
      node.addEventListener("focus", function () { if (!pinned) choose(node, false); });
      node.addEventListener("click", function () { choose(node, true); });
      node.addEventListener("keydown", function (e) {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        choose(node, true);
      });
    });
    host.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      var back = host.querySelector("[aria-pressed='true']");
      closeBoard();
      if (back && back.focus) back.focus();
    });
    var shut = host.querySelector(".fb-close");
    if (shut) shut.addEventListener("click", function () {
      var back = host.querySelector("[aria-pressed='true']");
      closeBoard();
      if (back && back.focus) back.focus();
    });

    paint(current, false);
    tick();
    host.addEventListener("mouseenter", function () { host.classList.add("is-paused"); syncMotion(host); });
    host.addEventListener("mouseleave", function () { host.classList.remove("is-paused"); syncMotion(host); });
    host.addEventListener("focusin", function () { host.classList.add("is-paused"); syncMotion(host); });
    host.addEventListener("focusout", function () { host.classList.remove("is-paused"); syncMotion(host); });
    if (typeof IntersectionObserver === "function") {
      var watch = new IntersectionObserver(function (entries) {
        var seen = entries && entries[0] && entries[0].isIntersecting;
        host.classList.toggle("is-off", !seen);
        syncMotion(host);
      }, { threshold: 0.2 });
      watch.observe(host);
    }
    syncMotion(host);
    root.__SFDC24_FLEET.refresh = tick;
  }

  var api = {
    classify: classify,
    whatsappStatus: whatsappStatus,
    ROSTER: ROSTER,
    FEED_PATH: FEED_PATH,
    SSE_PATH: SSE_PATH,
    RECHECK_MS: RECHECK_MS,
    RETRY_MS: RETRY_MS
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.__SFDC24_FLEET = api;
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
    else boot();
  }
})(typeof window !== "undefined" ? window : globalThis);
