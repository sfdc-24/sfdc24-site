/* Renders the model from xp-adapter.js. No key names live here. */
(function () {
  "use strict";

  function esc(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function identity() {
    var injected = window.SFDC24_XP_IDENTITY;
    if (injected && typeof injected.role === "string" && injected.role) return injected;
    var host = location.hostname;
    var local = host === "localhost" || host === "127.0.0.1" || location.protocol === "file:";
    if (local && new URLSearchParams(location.search).get("preview") === "owner") {
      return { role: "owner", preview: true };
    }
    return null;
  }

  function highlight(xp) {
    Array.prototype.forEach.call(document.querySelectorAll(".xp-focus"), function (el) {
      el.classList.remove("xp-focus");
    });
    var el = document.querySelector('[data-xp-id="' + (window.CSS && CSS.escape ? CSS.escape(xp) : xp) + '"]');
    if (!el) return;
    el.classList.add("xp-focus");
    if (el.scrollIntoView) el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function openDetail(xp, title, rows) {
    var dlg = document.getElementById("xp-detail");
    document.getElementById("xp-detail-title").textContent = title;
    document.getElementById("xp-detail-body").innerHTML = rows.map(function (row) {
      return "<dt>" + esc(row[0]) + "</dt><dd>" + esc(row[1]) + "</dd>";
    }).join("");
    var url = new URL(location.href);
    url.searchParams.set("focus", xp);
    history.replaceState(null, "", url.pathname + url.search);
    highlight(xp);
    if (!dlg.open) dlg.showModal();
  }

  function kinds(map) {
    return Object.keys(map).map(function (kind) { return map[kind] + " " + kind; }).join(" · ");
  }

  function blank(id) {
    return "<p class=\"xp-empty\" data-xp-id=\"" + id + "\">not yet reported</p>";
  }

  function modeChip(mode, feed) {
    if (!mode || mode === "unknown") return "";
    var tag = feed ? "p" : "span";
    var id = (feed ? "feed-" : "mode-") + String(mode).replace(/[^a-z0-9-]+/g, "");
    var tone = mode === "live" ? " is-live" : (mode === "mixed" ? " is-mixed" : "");
    return "<" + tag + " class=\"xp-mode" + tone + "\" data-xp-id=\"" + id + "\">" + esc(mode) + " mode</" + tag + ">";
  }

  function render(model, preview) {
    var badge = [];
    badge.push(model.source === "live" ? "Live" : "Fixture");
    if (model.snapshotStale) badge.push("Stale");
    if (preview) badge.push("Local preview");
    document.getElementById("xp-badge").innerHTML = badge.map(function (word) {
      return "<span" + (word === "Stale" ? " class=\"is-stale\"" : "") + ">" + esc(word) + "</span>";
    }).join("");
    document.getElementById("xp-stale").hidden = !model.snapshotStale;

    var sup = model.supervisor;
    var supCls = "xp-sup" + (sup.liveness === "active" ? " is-live" : "") + (sup.liveness === "stale" ? " is-stalled" : "");
    var supMode = modeChip(model.fleetMode, false);
    document.getElementById("xp-sup").outerHTML =
      "<button type=\"button\" id=\"xp-sup\" class=\"" + supCls + "\" data-xp-kind=\"agent\" data-xp-id=\"agent-pi1-cli\" data-xp-label=\"pi1 supervisor\" data-xp-open=\"agent-pi1-cli\">" +
      "<span class=\"xp-kicker\" data-xp-id=\"role-supervisor\" data-xp-label=\"Supervisor\">Supervisor</span>" +
      "<strong>pi1-cli</strong><p>" + (sup.reported ? esc(sup.env) : "not yet reported") + "</p>" + supMode + "</button>";

    document.getElementById("xp-agents").innerHTML = model.agents.length ? model.agents.map(function (agent) {
      var flags = "";
      if (agent.stalled) flags += "<span class=\"xp-flag is-stalled\">Stalled</span>";
      if (agent.waiting) flags += "<span class=\"xp-flag is-wait\">Waiting</span>";
      if (agent.instances.length && agent.instances.every(function (item) { return item.presence === "unconfirmed"; })) {
        flags += "<span class=\"xp-flag is-quiet\">Unconfirmed</span>";
      }
      var live = agent.instances.some(function (item) { return item.liveness === "active"; });
      var cls = "xp-card" + (agent.stalled ? " is-stalled" : agent.waiting ? " is-wait" : "") + (live ? " is-live" : " is-quiet");
      var chips = agent.instances.map(function (item) {
        return "<button type=\"button\" class=\"xp-chip\" data-xp-kind=\"instance\" data-xp-id=\"" + esc(item.xp) + "\" data-xp-label=\"" + esc(item.label) + "\" data-xp-open=\"" + esc(item.xp) + "\">" + esc(item.env) + "</button>";
      }).join("");
      var doing = agent.doing !== "unknown" ? "<p>" + esc(agent.doing) + "</p>" : "";
      return "<div class=\"" + cls + "\"><button type=\"button\" class=\"xp-hit\" data-xp-kind=\"agent\" data-xp-id=\"" + esc(agent.xp) + "\" data-xp-label=\"" + esc(agent.label) + "\" data-xp-open=\"" + esc(agent.xp) + "\"><strong>" + esc(agent.label) + "</strong>" + doing +
        (flags ? "<span class=\"xp-row\">" + flags + "</span>" : "") +
        "</button><div class=\"xp-row\">" + chips + "</div></div>";
    }).join("") : blank("empty-agents");

    document.getElementById("xp-milestones").innerHTML = model.milestones.length ? model.milestones.map(function (item) {
      var pct = item.pct === "unknown" ? "unknown" : item.pct + "%";
      return "<button type=\"button\" class=\"xp-ms\" data-xp-kind=\"milestone\" data-xp-id=\"" + esc(item.xp) + "\" data-xp-label=\"" + esc(item.label) + "\" data-xp-open=\"" + esc(item.xp) + "\"><strong>" + esc(item.label) + "</strong><small>" + esc(pct) + "</small></button>";
    }).join("") : blank("empty-milestones");

    document.getElementById("xp-tasks").innerHTML = model.tasks.length ? model.tasks.map(function (task) {
      var flag = task.waiting ? " · Waiting" : "";
      return "<button type=\"button\" class=\"xp-task\" data-xp-kind=\"task\" data-xp-id=\"" + esc(task.xp) + "\" data-xp-label=\"" + esc(task.label) + "\" data-xp-open=\"" + esc(task.xp) + "\"><strong>" + esc(task.label) + "</strong><small>" + esc(task.state) + flag + "</small></button>";
    }).join("") : blank("empty-tasks");

    var feed = document.getElementById("xp-feed");
    var mark = modeChip(model.fleetMode, true);
    if (!model.feed.length) {
      feed.innerHTML = mark + blank("empty-feed");
    } else {
      feed.innerHTML = mark + model.feed.map(function (entry) {
        return "<button type=\"button\" data-xp-kind=\"feed\" data-xp-id=\"" + esc(entry.xp) + "\" data-xp-label=\"" + esc(entry.action) + "\" data-xp-open=\"" + esc(entry.xp) + "\"><time>" + esc(entry.time) + "</time><span><b>" + esc(entry.action) + "</b><em>" + esc(entry.target) + " · " + esc(entry.outcome) + "</em></span></button>";
      }).join("");
    }

    var metric = document.getElementById("xp-metric-body");
    if (!model.output.hours.length) {
      metric.innerHTML = blank("empty-output");
    } else {
      var max = 1;
      model.output.hours.forEach(function (hour) { if (hour.shown && hour.count > max) max = hour.count; });
      var bars = model.output.hours.map(function (hour) {
        var left = ((hour.index + 0.15) / 24 * 100).toFixed(2);
        var height = hour.shown ? Math.max(8, Math.round(hour.count / max * 100)) : 0;
        var tick = hour.stepped ? "<i class=\"xp-tick\" style=\"left:" + left + "%;bottom:" + height + "%\" data-xp-stepped=\"" + esc(hour.at) + "\"></i>" : "";
        var bar = hour.shown ? "<i class=\"xp-bar-col\" data-xp-bar=\"" + esc(hour.at) + "\" data-count=\"" + hour.count + "\" style=\"left:" + left + "%;height:" + height + "%\"></i>" : "";
        return tick + bar;
      }).join("");
      var first = model.output.hours[0];
      var last = model.output.hours[model.output.hours.length - 1];
      var note = model.output.reported ? "" : blank("empty-output");
      metric.innerHTML = "<div class=\"xp-track\">" + bars + "</div><div class=\"xp-axis\"><span>" + esc(first ? first.time : "") + "</span><span>24h</span><span>" + esc(last ? last.time : "") + "</span></div>" + note;
    }

    var details = {};
    details["agent-pi1-cli"] = ["pi1-cli", [
      ["Role", sup.roleReported],
      ["Mode", model.fleetMode || "unknown"],
      ["As of", sup.at],
      ["Environment", sup.reported ? sup.env : "not yet reported"],
      ["Liveness", sup.liveness],
      ["Checks run", sup.checks_run],
      ["Waits unblocked", sup.waits_unblocked],
      ["Delivery gaps", sup.delivery_gaps],
      ["Escalations", sup.escalations],
      ["Open incidents", sup.open_incidents],
      ["Redis pending", sup.redis_pending]
    ]];
    details["role-supervisor"] = details["agent-pi1-cli"];
    model.agents.forEach(function (agent) {
      details[agent.xp] = [agent.label, [
        ["Doing", agent.doing],
        ["Environment", agent.env],
        ["Stalled", agent.stalled ? "yes" : "no"],
        ["Waiting", agent.waiting ? "yes" : "no"],
        ["Instances", String(agent.instances.length)]
      ]];
      agent.instances.forEach(function (item) {
        details[item.xp] = [item.label, [
          ["Environment", item.env],
          ["Presence", item.presence],
          ["Liveness", item.liveness],
          ["Redis read", item.redis],
          ["Last seen", item.seen]
        ]];
      });
    });
    model.milestones.forEach(function (item) {
      var rows = [["Percent", item.pct], ["Status", item.rag]];
      item.items.forEach(function (child) { rows.push([child.label, child.status]); });
      details[item.xp] = [item.label, rows];
    });
    model.tasks.forEach(function (task) {
      details[task.xp] = [task.label, [
        ["State", task.state],
        ["Waiting", task.waiting ? "yes" : "no"],
        ["Note", task.note],
        ["Owner", task.by || "unknown"]
      ]];
    });
    model.feed.forEach(function (entry) {
      details[entry.xp] = [entry.action, [
        ["Time", entry.time],
        ["Target", entry.target],
        ["Kind", entry.kind],
        ["Outcome", entry.outcome],
        ["Ref", entry.ref || "unknown"],
        ["Mode", entry.mode || "unknown"],
        ["Key", entry.key]
      ]];
    });
    var outRows = model.output.agents.map(function (agent) {
      return [agent.agent, kinds(agent.kinds)];
    });
    if (!outRows.length) outRows.push(["Output", "not yet reported"]);
    details["metric-output-per-hour"] = ["Output", outRows];
    details["feed-supervisor"] = ["Supervisor", model.feed.length ? model.feed.map(function (entry) {
      return [entry.time, entry.action];
    }) : [["Feed", "not yet reported"]]];

    document.getElementById("xp-app").onclick = function (event) {
      var el = event.target.closest("[data-xp-open]");
      if (!el || !document.getElementById("xp-app").contains(el)) return;
      var xp = el.getAttribute("data-xp-open");
      var spec = details[xp];
      if (!spec) return;
      openDetail(xp, spec[0], spec[1]);
    };
  }

  function draw(model) {
    var stage = document.getElementById("xp-stage");
    var svg = document.getElementById("xp-lines");
    if (!stage || !svg) return;
    var box = stage.getBoundingClientRect();
    var width = Math.max(1, stage.clientWidth);
    var height = Math.max(1, stage.clientHeight);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    function spot(xp) {
      var el = document.querySelector("#xp-stage [data-xp-id=\"" + xp + "\"]");
      if (!el) return null;
      var card = el.closest && el.closest(".xp-card");
      if (card) el = card;
      var rect = el.getBoundingClientRect();
      return {
        x: rect.left - box.left + rect.width / 2,
        y: rect.top - box.top + rect.height / 2,
        top: rect.top - box.top,
        bottom: rect.bottom - box.top,
        left: rect.left - box.left,
        right: rect.right - box.left
      };
    }
    function n(v) { return v.toFixed(1); }
    var from = spot("agent-pi1-cli");
    var paths = "<defs><linearGradient id=\"xp-flow-grad\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\"><stop stop-color=\"#7ee7ff\"/><stop offset=\"1\" stop-color=\"#b388ff\"/></linearGradient></defs>";
    model.watches.forEach(function (watch) {
      var to = spot(watch.to);
      if (!from || !to) return;
      paths += "<path class=\"xp-watch\" data-xp-id=\"" + watch.xp + "\" d=\"M" + n(from.x) + " " + n(from.bottom) + " L" + n(to.x) + " " + n(to.top) + "\"></path>";
    });
    model.flows.forEach(function (flow) {
      var a = spot(flow.from);
      var b = spot(flow.to);
      if (!a || !b) return;
      var x1 = a.x, y1 = a.bottom, x2 = b.x, y2 = b.top, c1 = y1, c2 = y2;
      if (Math.abs(a.y - b.y) < 40) {
        x1 = a.x < b.x ? a.right : a.left;
        x2 = a.x < b.x ? b.left : b.right;
        y1 = a.bottom;
        y2 = b.bottom;
        c1 = c2 = y1 + 18;
      } else if (a.y > b.y) {
        y1 = a.top;
        y2 = b.bottom;
        c1 = c2 = (y1 + y2) / 2;
      } else {
        c1 = c2 = (y1 + y2) / 2;
      }
      paths += "<path class=\"xp-flow\" data-xp-id=\"" + flow.xp + "\" d=\"M" + n(x1) + " " + n(y1) + " C" + n(x1) + " " + n(c1) + " " + n(x2) + " " + n(c2) + " " + n(x2) + " " + n(y2) + "\"></path>";
    });
    svg.innerHTML = paths;
  }

  function boot() {
    var who = identity();
    fetch("/xp/allow.json", { cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error("allow");
      return res.json();
    }).catch(function () { return { roles: [] }; }).then(function (list) {
      if (!window.SFDC24Xp.allow(who, list).ok) {
        document.getElementById("xp-lock").hidden = false;
        return;
      }
      document.getElementById("xp-app").hidden = false;
      var prefer = new URLSearchParams(location.search).get("source") || "";
      return window.SFDC24Xp.load({
        fetch: window.fetch.bind(window),
        liveUrl: "/data/xp-live.json",
        fixtureUrl: "/data/xp-fixture.json",
        prefer: prefer
      }).then(function (bundle) {
        var model = window.SFDC24Xp.normalize(bundle);
        render(model, !!(who && who.preview));
        var focus = new URLSearchParams(location.search).get("focus");
        if (focus) highlight(focus);
        draw(model);
        window.addEventListener("resize", function () { draw(model); });
      }).catch(function () {
        document.getElementById("xp-badge").innerHTML = "<span class=\"is-stale\">Missing</span>";
      });
    });

    document.getElementById("xp-stage").addEventListener("keydown", function (event) {
      if (["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].indexOf(event.key) < 0) return;
      var nodes = Array.prototype.slice.call(document.querySelectorAll("#xp-stage [data-xp-kind='agent']"));
      var index = nodes.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      var step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
      var next = (index + step + nodes.length) % nodes.length;
      nodes[next].focus();
    });
    document.querySelector(".xp-close").addEventListener("click", function () {
      document.getElementById("xp-detail").close();
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
