/* Redis key names for the fleet view. Edit KEYS only. See xp/README.md. */
(function (root) {
  "use strict";

  var ALIVE_WINDOW_S = 300;
  var HOURS = 24;
  var KEYS = {
    canon: "v1:agent:canon",
    agent: "v1:agent:{id}",
    family: "v1:agent:family:{family}",
    alive: "fleet:alive:{id}",
    inbox: "fleet:inbox:{id}",
    accept: "fleet:worker:accept:{task}",
    done: "fleet:worker:done:{task}",
    milestone: "proj:milestones:v1:{stream}",
    milestonesMeta: "proj:milestones:v1:meta",
    busRow: "v1:bus:row:{id}",
    supervisorId: "pi1-cli",
    supervisorEvents: "fleet:supervisor:pi1-cli:events",
    supervisorLog: "fleet:supervisor:events",
    supervisorHash: "fleet:supervisor:pi1-cli",
    aliveWindowSec: ALIVE_WINDOW_S
  };

  var FAMILY_ORDER = ["claude", "codex", "gemini", "grok", "cursor", "copilot", "pi"];
  var TASK_XP = {
    "task-0123456789abcdef": "task-pr-52",
    "task-abcdef0123456789": "task-gate",
    "task-fedcba9876543210": "task-done"
  };
  var FEED_KIND = {
    nudge: "nudge", stall: "stall", wait: "wait", duplicate: "duplicate",
    dup: "duplicate", check: "check", escalation: "escalation", escalate: "escalation",
    delivery_gap: "delivery_gap", unblock: "unblock"
  };
  var OUTPUT_KIND = {
    done: "task", succeeded: "task", "task-done": "task",
    review: "review", "pr-review": "review",
    commit: "commit", round: "round", landed: "round"
  };

  function fill(template, map) {
    return template.replace(/\{(\w+)\}/g, function (_, k) { return map[k] == null ? "" : map[k]; });
  }

  function allow(identity, list) {
    var roles = list && Array.isArray(list.roles) ? list.roles : [];
    var role = identity && typeof identity.role === "string" ? identity.role : "";
    if (!role || roles.indexOf(role) < 0) return { ok: false, reason: role ? "role" : "identity" };
    return { ok: true, role: role };
  }

  function scrub(value) {
    var text = value == null ? "" : String(value);
    if (!text) return "";
    if (text.indexOf("@") >= 0) return "";
    if (/\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/.test(text)) return "";
    return text.trim();
  }

  function few(text, n) {
    var parts = scrub(text).split(/\s+/).filter(Boolean);
    if (!parts.length) return "";
    return parts.slice(0, n || 4).join(" ");
  }

  function canonOf(table, tag) {
    var raw = String(tag || "").trim().toLowerCase();
    if (!raw || !table) return raw;
    var mapped = table[raw];
    return mapped ? String(mapped).trim().toLowerCase() : raw;
  }

  function envOf(runtime) {
    var text = scrub(runtime).toLowerCase();
    if (!text) return "unknown";
    if (text.indexOf("cloud run") >= 0) return "Cloud Run";
    if (text.indexOf("laptop") >= 0) return "laptop";
    if (text.indexOf("raspberry") >= 0 || /\bpi\b/.test(text)) return "Pi";
    if (text.indexOf("vm") >= 0 || text.indexOf("azure") >= 0) return "VM";
    if (text.indexOf("box") >= 0) return "box";
    if (text.indexOf("phone") >= 0) return "phone";
    if (text.indexOf("cloud") >= 0) return "Cloud";
    return scrub(runtime);
  }

  function presence(state) {
    var text = scrub(state).toLowerCase();
    if (!text) return "unknown";
    if (text.indexOf("unconfirmed") >= 0) return "unconfirmed";
    if (/off|dormant|retired|powered/.test(text)) return "quiet";
    if (/active|deployed|up/.test(text)) return "up";
    return "unknown";
  }

  function liveness(epoch, clockMs) {
    if (epoch == null || epoch === "" || clockMs == null) return "unknown";
    var n = Number(epoch);
    if (!isFinite(n)) return "unknown";
    var age = Math.round(clockMs / 1000 - n);
    if (age < -60) return "unknown";
    return age > ALIVE_WINDOW_S ? "stale" : "active";
  }

  function parseAccept(value) {
    var parts = String(value || "").split(":");
    if (parts.length < 2) return null;
    var at = Number(parts[1]);
    if (!isFinite(at)) return null;
    var lease = parts.length > 2 && parts[2] !== "" ? Number(parts[2]) : null;
    if (lease != null && !isFinite(lease)) lease = null;
    return { by: parts[0], at: at, lease: lease };
  }

  function jsonObj(value) {
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    if (typeof value !== "string" || !value) return null;
    try {
      var parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  function listOf(value) {
    if (Array.isArray(value)) return value;
    return [];
  }

  function etClock(ms) {
    if (!isFinite(ms)) return "unknown";
    try {
      var formatted = new Intl.DateTimeFormat("en-GB", {
        timeZone: "America/Toronto",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
      }).format(new Date(ms));
      return formatted + " ET";
    } catch (e) {
      return "unknown";
    }
  }

  function hourKey(ms) {
    if (!isFinite(ms)) return "";
    var d = new Date(ms);
    d.setUTCMinutes(0, 0, 0);
    return d.toISOString().replace(".000Z", "Z");
  }

  function slug(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
  }

  function hashOf(value) {
    if (typeof value === "string") return jsonObj(value);
    if (value && typeof value === "object") return value;
    return null;
  }

  function fieldText(hash, field) {
    if (!hash || hash[field] == null || scrub(hash[field]) === "") return "unknown";
    return scrub(hash[field]);
  }

  function fieldNum(hash, field) {
    var text = fieldText(hash, field);
    if (text === "unknown" || !/^-?\d+(\.\d+)?$/.test(text)) return "unknown";
    return String(Number(text));
  }

  function fieldWhen(hash, field) {
    var text = fieldText(hash, field);
    if (text === "unknown") return text;
    var ms = Date.parse(text);
    return isFinite(ms) ? etClock(ms) : text;
  }

  function asRecord(entry) {
    if (entry && typeof entry === "object") return entry;
    if (typeof entry === "string") return jsonObj(entry) || { action: entry };
    return { action: "unknown" };
  }

  function feedRow(entry, key) {
    entry = asRecord(entry);
    var at = Date.parse(entry.at || entry.ts || "");
    var rawKind = typeof entry.kind === "string" ? entry.kind : "";
    var actionSrc = typeof entry.action === "string"
      ? entry.action
      : (typeof entry.text === "string" ? entry.text.replace(/^[a-z_]+\s*:\s*/i, "") : "");
    return {
      id: entry.id == null || entry.id === "" ? "" : String(entry.id),
      at: isFinite(at) ? at : null,
      time: isFinite(at) ? etClock(at) : "unknown",
      kind: kindOf(rawKind, FEED_KIND) || "action",
      target: scrub(entry.target || entry.agent) || "unknown",
      action: few(actionSrc, 6) || "unknown",
      outcome: scrub(typeof entry.outcome === "string" ? entry.outcome : "") || "unknown",
      ref: scrub(entry.ref) || "unknown",
      mode: (scrub(typeof entry.mode === "string" ? entry.mode : "") || "unknown").toLowerCase(),
      key: key
    };
  }

  function sameFeed(a, b) {
    if (a.id && b.id && a.id === b.id) return true;
    return a.at === b.at && a.kind === b.kind && a.target === b.target && a.action === b.action && a.ref === b.ref;
  }

  function addFeed(feed, row) {
    for (var i = 0; i < feed.length; i += 1) if (sameFeed(feed[i], row)) return;
    row.xp = "act-" + slug(row.id || row.ref || row.target) + "-" + feed.length;
    feed.push(row);
  }

  function reconcileMode(hashMode, rows) {
    var seen = [];
    function add(mode) {
      mode = scrub(mode).toLowerCase();
      if (!mode || mode === "unknown" || seen.indexOf(mode) >= 0) return;
      seen.push(mode);
    }
    add(hashMode);
    for (var i = 0; i < rows.length; i += 1) add(rows[i].mode);
    if (!seen.length) return "unknown";
    return seen.length > 1 ? "mixed" : seen[0];
  }

  function kindOf(token, table) {
    var key = String(token || "").trim().toLowerCase();
    return table[key] || "";
  }

  function inboxKind(text) {
    var match = /^([a-z_]+)\s*:/i.exec(scrub(text));
    return match ? kindOf(match[1], FEED_KIND) : "";
  }

  function entriesFromStream(value) {
    if (typeof value === "string") {
      try { value = JSON.parse(value); } catch (e) { return []; }
    }
    if (Array.isArray(value)) return value;
    if (value && Array.isArray(value.entries)) return value.entries;
    return [];
  }

  function load(opts) {
    var prefer = opts && opts.prefer;
    function take(url, source) {
      return opts.fetch(url, { cache: "no-store" }).then(function (res) {
        if (!res.ok) throw new Error(source);
        return res.json();
      }).then(function (body) {
        body = body && typeof body === "object" ? body : {};
        body.source = source;
        return body;
      });
    }
    if (prefer === "fixture") return take(opts.fixtureUrl, "fixture");
    return take(opts.liveUrl, "live").catch(function () {
      return take(opts.fixtureUrl, "fixture");
    });
  }

  function normalize(bundle, opts) {
    bundle = bundle || {};
    var keys = bundle.keys || {};
    var source = bundle.source === "live" ? "live" : "fixture";
    var readAt = Date.parse(bundle.read_at || "");
    var clock = isFinite(readAt) ? readAt : null;
    var wall = opts && opts.now != null ? opts.now : Date.now();
    var snapshotStale = source === "live" && (clock == null || wall - clock > ALIVE_WINDOW_S * 1000);
    var table = keys[KEYS.canon] || {};
    var supId = KEYS.supervisorId;
    var hash = hashOf(keys[KEYS.supervisorHash]);

    var instances = {};
    var families = {};
    Object.keys(keys).forEach(function (key) {
      if (key.indexOf("v1:agent:family:") === 0) {
        families[key.slice("v1:agent:family:".length)] = keys[key] || {};
      } else if (key.indexOf("v1:agent:") === 0 && key !== KEYS.canon && key.indexOf("v1:agent:family:") !== 0 && key !== "v1:agent:roster" && key !== "v1:agent:seeded") {
        instances[key.slice("v1:agent:".length)] = keys[key] || {};
      }
    });

    function familyOf(id) {
      var row = instances[id];
      if (row && row.family) return String(row.family).toLowerCase();
      var canon = canonOf(table, id);
      row = instances[canon];
      return row && row.family ? String(row.family).toLowerCase() : canon;
    }

    var tasks = [];
    Object.keys(keys).forEach(function (key) {
      if (key.indexOf("fleet:worker:accept:") !== 0) return;
      var task = key.slice("fleet:worker:accept:".length);
      var accept = parseAccept(keys[key]);
      var doneRaw = keys["fleet:worker:done:" + task];
      var done = jsonObj(doneRaw);
      var waiting = false;
      if (accept && clock != null && !done && accept.lease != null) {
        waiting = (clock / 1000 - accept.at) > accept.lease;
      }
      var doneAt = done && (done.at || done.ts) ? Date.parse(done.at || done.ts) : NaN;
      tasks.push({
        id: task,
        xp: TASK_XP[task] || slug(task),
        label: TASK_XP[task] || task,
        by: accept ? accept.by : (done && done.by) || "",
        family: familyOf(accept ? accept.by : (done && done.by) || ""),
        state: done ? scrub(done.state) || "unknown" : (accept ? "accepted" : "unknown"),
        note: done ? (scrub(done.note) || "unknown") : "unknown",
        waiting: waiting,
        at: isFinite(doneAt) ? doneAt : null,
        output: done && isFinite(doneAt) && kindOf(done.state, OUTPUT_KIND) ? kindOf(done.state, OUTPUT_KIND) : ""
      });
    });

    var feed = [];
    var dedicated = Object.prototype.hasOwnProperty.call(keys, KEYS.supervisorEvents);
    if (dedicated) {
      entriesFromStream(keys[KEYS.supervisorEvents]).forEach(function (entry) {
        addFeed(feed, feedRow(entry, KEYS.supervisorEvents));
      });
    } else {
      Object.keys(keys).forEach(function (key) {
        if (key.indexOf("fleet:inbox:") !== 0) return;
        var target = key.slice("fleet:inbox:".length);
        entriesFromStream(keys[key]).forEach(function (entry) {
          entry = asRecord(entry);
          if (canonOf(table, entry.by) !== supId && String(entry.by || "").toLowerCase() !== supId) return;
          addFeed(feed, feedRow({
            id: entry.id,
            at: entry.at,
            kind: inboxKind(entry.text) || "action",
            target: target,
            action: String(entry.text || "").replace(/^[a-z_]+\s*:\s*/i, "")
          }, key));
        });
      });
      Object.keys(keys).forEach(function (key) {
        if (key.indexOf("v1:bus:row:") !== 0) return;
        var row = keys[key] || {};
        if (canonOf(table, row.source_tag) !== supId && String(row.source_tag || "").toLowerCase() !== supId) return;
        addFeed(feed, feedRow({
          id: row.row_id || key,
          at: row.ts,
          kind: row.action_type,
          target: row.target_surface,
          action: row.gist,
          outcome: row.subgist,
          ref: row.ref,
          mode: row.mode
        }, key));
      });
    }
    if (Object.prototype.hasOwnProperty.call(keys, KEYS.supervisorLog)) {
      entriesFromStream(keys[KEYS.supervisorLog]).forEach(function (entry) {
        addFeed(feed, feedRow(entry, KEYS.supervisorLog));
      });
    }
    feed.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    var fleetMode = reconcileMode(hash && hash.mode, feed);

    var outputEvents = [];
    Object.keys(keys).forEach(function (key) {
      if (key.indexOf("v1:bus:row:") !== 0) return;
      var row = keys[key] || {};
      var kind = kindOf(row.action_type, OUTPUT_KIND);
      var at = Date.parse(row.ts || "");
      if (!kind || !isFinite(at)) return;
      outputEvents.push({
        at: at,
        kind: kind,
        agent: familyOf(row.source_tag) || scrub(row.source_tag) || "unknown",
        label: scrub(row.source_tag) || "unknown"
      });
    });
    tasks.forEach(function (task) {
      if (!task.output || task.at == null) return;
      outputEvents.push({ at: task.at, kind: task.output, agent: task.family || "unknown", label: task.by || "unknown" });
    });

    var output = { reported: false, hours: [], agents: [], stepped: [] };
    if (clock != null) {
      var end = hourKey(clock);
      var endMs = Date.parse(end);
      var startMs = endMs - (HOURS - 1) * 3600000;
      var buckets = {};
      outputEvents.forEach(function (event) {
        if (event.at < startMs || event.at >= endMs + 3600000) return;
        var key = hourKey(event.at);
        if (!buckets[key]) buckets[key] = { count: 0, kinds: {} };
        buckets[key].count += 1;
        buckets[key].kinds[event.kind] = (buckets[key].kinds[event.kind] || 0) + 1;
      });
      var stepped = {};
      feed.forEach(function (entry) {
        if (entry.at == null || entry.at < startMs || entry.at >= endMs + 3600000) return;
        stepped[hourKey(entry.at)] = true;
      });
      var inWindow = outputEvents.filter(function (event) {
        return event.at >= startMs && event.at < endMs + 3600000;
      });
      var stepKeys = Object.keys(stepped);
      if (inWindow.length || stepKeys.length) {
        output.reported = inWindow.length > 0;
        for (var n = 0; n < HOURS; n += 1) {
          var ms = startMs + n * 3600000;
          var key = new Date(ms).toISOString().replace(".000Z", "Z");
          var bucket = buckets[key];
          if (!bucket && !stepped[key]) continue;
          output.hours.push({
            at: key,
            index: n,
            time: etClock(ms),
            count: bucket ? bucket.count : 0,
            kinds: bucket ? bucket.kinds : {},
            stepped: !!stepped[key],
            shown: !!bucket
          });
        }
        var byAgent = {};
        inWindow.forEach(function (event) {
          if (!byAgent[event.agent]) byAgent[event.agent] = {};
          byAgent[event.agent][event.kind] = (byAgent[event.agent][event.kind] || 0) + 1;
        });
        output.agents = Object.keys(byAgent).sort().map(function (agent) {
          return { agent: agent, xp: "out-" + slug(agent), kinds: byAgent[agent] };
        });
        output.stepped = stepKeys.sort();
      }
    }

    function card(family) {
      var meta = families[family] || {};
      var ids = String(meta.instances || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean);
      Object.keys(instances).forEach(function (id) {
        if (familyOf(id) === family && ids.indexOf(id) < 0 && id !== supId) ids.push(id);
      });
      ids = ids.filter(function (id) { return id !== supId; });
      var inst = ids.map(function (id) {
        var row = instances[id] || {};
        var beat = keys[fill(KEYS.alive, { id: id })];
        return {
          id: id,
          xp: "inst-" + slug(id),
          label: id,
          env: envOf(row.runtime),
          presence: presence(row.state),
          liveness: beat == null ? "unknown" : liveness(beat, clock),
          redis: row.redis_read == null || row.redis_read === "" ? "unknown" : scrub(row.redis_read),
          seen: scrub(row.last_seen) || "unknown"
        };
      });
      var ownTasks = tasks.filter(function (task) { return task.family === family; });
      var stalled = inst.some(function (item) { return item.liveness === "stale"; });
      var waiting = ownTasks.some(function (task) { return task.waiting; });
      var doing = "";
      Object.keys(keys).forEach(function (key) {
        if (key.indexOf("fleet:inbox:") !== 0) return;
        var owner = familyOf(key.slice("fleet:inbox:".length));
        if (owner !== family) return;
        entriesFromStream(keys[key]).forEach(function (entry) {
          if (canonOf(table, entry.by) === supId) return;
          var words = few(entry.text, 4);
          if (words) doing = words;
        });
      });
      var envs = [];
      inst.forEach(function (item) {
        if (item.env !== "unknown" && envs.indexOf(item.env) < 0) envs.push(item.env);
      });
      return {
        id: family,
        xp: "agent-" + family,
        label: scrub(meta.name) || family,
        role: scrub(meta.role) || "unknown",
        doing: doing || "unknown",
        env: envs.join(" · ") || "unknown",
        stalled: stalled,
        waiting: waiting,
        instances: inst,
        tasks: ownTasks
      };
    }

    var agentIds = FAMILY_ORDER.filter(function (family) { return families[family] || Object.keys(instances).some(function (id) { return familyOf(id) === family && id !== supId; }); });
    Object.keys(families).forEach(function (family) {
      if (agentIds.indexOf(family) < 0) agentIds.push(family);
    });
    var agents = agentIds.map(card).filter(function (agent) { return agent.instances.length || families[agent.id]; });

    var supRow = instances[supId] || {};
    var supBeat = keys[fill(KEYS.alive, { id: supId })];
    var supervisor = {
      id: supId,
      xp: "agent-pi1-cli",
      label: "pi1-cli",
      role: "Supervisor",
      env: supRow.runtime ? envOf(supRow.runtime) : "unknown",
      liveness: supBeat == null ? "unknown" : liveness(supBeat, clock),
      reported: !!(hash && Object.keys(hash).length) || feed.length > 0 || supBeat != null,
      at: fieldWhen(hash, "at"),
      roleReported: fieldText(hash, "role"),
      mode: fieldText(hash, "mode"),
      checks_run: fieldNum(hash, "checks_run"),
      waits_unblocked: fieldNum(hash, "waits_unblocked"),
      delivery_gaps: fieldNum(hash, "delivery_gaps"),
      escalations: fieldNum(hash, "escalations"),
      open_incidents: fieldNum(hash, "open_incidents"),
      redis_pending: fieldNum(hash, "redis_pending")
    };

    var flows = [];
    Object.keys(keys).forEach(function (key) {
      if (key.indexOf("fleet:inbox:") !== 0) return;
      var targetFamily = familyOf(key.slice("fleet:inbox:".length));
      entriesFromStream(keys[key]).forEach(function (entry) {
        var fromId = canonOf(table, entry.by);
        if (fromId === supId) return;
        var fromFamily = familyOf(fromId);
        if (!fromFamily || fromFamily === targetFamily) return;
        flows.push({
          xp: "flow-" + fromFamily + "-" + targetFamily,
          from: "agent-" + fromFamily,
          to: "agent-" + targetFamily
        });
      });
    });

    var milestones = [];
    Object.keys(keys).forEach(function (key) {
      if (key.indexOf("proj:milestones:v1:") !== 0 || key === KEYS.milestonesMeta) return;
      var stream = key.slice("proj:milestones:v1:".length);
      var row = keys[key] || {};
      var items = [];
      var parsed = jsonObj(row.milestones);
      listOf(parsed).forEach(function (item) {
        items.push({
          xp: "ms-" + slug(item.id || stream),
          label: few(item.title, 4) || "unknown",
          status: scrub(item.status) || "unknown"
        });
      });
      milestones.push({
        id: stream,
        xp: "ms-" + slug(stream),
        label: scrub(row.name) || stream,
        pct: row.pct == null || row.pct === "" ? "unknown" : scrub(row.pct),
        rag: scrub(row.rag) || "unknown",
        items: items
      });
    });
    milestones.sort(function (a, b) { return a.label < b.label ? -1 : 1; });

    return {
      source: source,
      snapshotStale: snapshotStale,
      readAt: isFinite(readAt) ? bundle.read_at : "",
      clock: etClock(clock),
      supervisor: supervisor,
      agents: agents,
      flows: flows,
      watches: agents.map(function (agent) { return { xp: "watch-" + agent.id, to: agent.xp }; }),
      milestones: milestones,
      tasks: tasks,
      feed: feed,
      practiceMode: fleetMode === "practice",
      fleetMode: fleetMode,
      output: output
    };
  }

  root.SFDC24Xp = {
    KEYS: KEYS,
    allow: allow,
    load: load,
    normalize: normalize,
    etClock: etClock
  };
})(window);
