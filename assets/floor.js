/* Renders floor diagrams, delivery tables, the key model, and the conference board. */
(function () {
  "use strict";
  var diagramN = 0;
  var WORKERS = ["Claude", "Grok", "Codex", "Gemini", "Cursor"];
  var CHIPS = ["Landed", "Need a decision", "Blocked", "Handed off"];

  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  function el(tag, attrs, text) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === "class") node.className = attrs[key];
        else node.setAttribute(key, attrs[key]);
      });
    }
    if (text != null) node.textContent = text;
    return node;
  }

  function initMermaid() {
    if (!window.mermaid || window.mermaid.__floor) return;
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      flowchart: { htmlLabels: true, wrappingWidth: 220, padding: 16, nodeSpacing: 36, rankSpacing: 44 },
      theme: "base",
      themeVariables: {
        primaryColor: "#F3F2EF",
        primaryTextColor: "#191919",
        primaryBorderColor: "#0A66C2",
        lineColor: "#191919",
        secondaryColor: "#FFFFFF",
        tertiaryColor: "#F3F2EF",
        fontFamily: "Public Sans, Segoe UI, sans-serif"
      }
    });
    window.mermaid.__floor = true;
  }

  function renderDiagram(node) {
    var url = node.getAttribute("data-diagram");
    var pre = node.querySelector("pre");
    var slot = node.querySelector(".diagram-svg");
    return fetch(url, {credentials: "omit"}).then(function (res) {
      if (!res.ok) throw new Error("diagram");
      return res.text();
    }).then(function (text) {
      if (pre) pre.textContent = text;
      if (!window.mermaid || !slot) return;
      initMermaid();
      diagramN += 1;
      var id = "floordia" + diagramN;
      var pending = window.mermaid.render(id, text);
      if (pending && pending.then) {
        return pending.then(function (out) {
          slot.innerHTML = out.svg;
          var figure = node.closest("figure");
          var fallback = figure && figure.querySelector(".diagram-fallback");
          if (fallback) fallback.hidden = true;
        });
      }
    }).catch(function () {
      if (pre) {
        var details = pre.closest("details");
        if (details) details.open = true;
      }
    });
  }

  function initDiagrams() {
    var nodes = document.querySelectorAll("[data-diagram]");
    var jobs = [];
    for (var i = 0; i < nodes.length; i++) jobs.push(renderDiagram(nodes[i]));
    return Promise.all(jobs);
  }

  function addRow(body, cells) {
    var tr = document.createElement("tr");
    cells.forEach(function (value, index) {
      tr.appendChild(el(index === 0 ? "th" : "td", index === 0 ? {scope: "row"} : {}, value || ""));
    });
    body.appendChild(tr);
  }

  function table(headers) {
    var tableNode = el("table", {class: "plain"});
    var head = document.createElement("thead");
    var row = document.createElement("tr");
    headers.forEach(function (header) {
      row.appendChild(el("th", {scope: "col"}, header));
    });
    head.appendChild(row);
    tableNode.appendChild(head);
    var body = document.createElement("tbody");
    tableNode.appendChild(body);
    return {table: tableNode, body: body};
  }

  function initDelivery() {
    var mount = document.getElementById("delivery-tables");
    if (!mount) return;
    fetch("/floor/diagrams/delivery.json", {credentials: "omit"}).then(function (res) {
      if (!res.ok) throw new Error("delivery");
      return res.json();
    }).then(function (data) {
      var note = document.getElementById("delivery-note");
      if (note && data.note) note.textContent = data.note;
      Object.keys(data.lanes || {}).forEach(function (key) {
        var lane = data.lanes[key];
        var section = el("section", {class: "card"});
        section.appendChild(el("h2", {}, lane.title));
        var built = table(["Stage", "Title", "Status", "Owner"]);
        (lane.items || []).forEach(function (item) {
          addRow(built.body, [item.stage, item.title, item.status, item.owner]);
        });
        section.appendChild(built.table);
        mount.appendChild(section);
      });
    }).catch(function () {
      mount.appendChild(el("p", {class: "note"}, "The delivery snapshot did not load."));
    });
  }

  function initModel() {
    var keys = document.getElementById("key-list");
    var chain = document.getElementById("chain-list");
    var access = document.getElementById("access-note");
    if (!keys && !chain && !access) return;
    fetch("/data/floor/model.json", {credentials: "omit"}).then(function (res) {
      if (!res.ok) throw new Error("model");
      return res.json();
    }).then(function (model) {
      if (access && model.access) access.textContent = model.access.note;
      if (keys) {
        (model.keys || []).forEach(function (key) {
          var section = el("section", {class: "card"});
          section.appendChild(el("h2", {class: "mono"}, key.pattern));
          var dl = el("dl", {class: "keys"});
          [["Group", key.group], ["Type", key.type], ["TTL", key.ttl], ["Fields", (key.fields || []).join(", ") || "none"], ["About", key.about]].forEach(function (pair) {
            dl.appendChild(el("dt", {}, pair[0]));
            dl.appendChild(el("dd", {}, pair[1]));
          });
          section.appendChild(dl);
          keys.appendChild(section);
        });
      }
      if (chain) {
        var roles = el("section", {class: "card"});
        roles.appendChild(el("h2", {}, "Who does what"));
        var roleList = document.createElement("ul");
        (model.roles || []).forEach(function (role) {
          roleList.appendChild(el("li", {}, role.name + " — " + role.duty));
        });
        roles.appendChild(roleList);
        chain.appendChild(roles);
        var steps = el("section", {class: "card"});
        steps.appendChild(el("h2", {}, "Handoffs"));
        var ol = document.createElement("ol");
        var byId = {};
        (model.roles || []).forEach(function (role) { byId[role.id] = role.name; });
        (model.steps || []).forEach(function (step) {
          var from = byId[step.from] || step.from;
          var to = byId[step.to] || step.to;
          ol.appendChild(el("li", {}, from + " to " + to + ": " + step.label));
        });
        steps.appendChild(ol);
        chain.appendChild(steps);
      }
    }).catch(function () {
      if (keys) keys.appendChild(el("p", {}, "The key model did not load."));
    });
  }

  function paintBanner(payload) {
    var banner = document.getElementById("floor-banner");
    if (!banner || banner.dataset.demoLock) return;
    banner.textContent = payload.notice || payload.banner || "Sample data. Not a live Redis read.";
  }

  function threadCard(row) {
    var li = el("li", {class: "card thread"});
    li.setAttribute("data-id", row.id);
    li.appendChild(el("h2", {}, row.title));
    var dl = el("dl", {class: "meta"});
    [
      ["Project", row.project],
      ["From", row.from],
      ["To", row.to],
      ["State", row.state],
      ["Assignee", row.assignee || "Unassigned"],
      ["Result", row.result || ""]
    ].forEach(function (pair) {
      if (!pair[1]) return;
      dl.appendChild(el("dt", {}, pair[0]));
      dl.appendChild(el("dd", {"data-field": pair[0].toLowerCase()}, pair[1]));
    });
    li.appendChild(dl);
    var flag = row.local
      ? "Local change on this screen. Not written to Redis."
      : "Sample";
    li.appendChild(el("p", {class: "flag"}, flag));

    var actions = el("div", {class: "actions"});
    actions.appendChild(actionButton("Acknowledge", function (button) { run(row.id, "acknowledge", "", button); }));
    actions.appendChild(actionButton("Escalate", function (button) { run(row.id, "escalate", "", button); }));
    li.appendChild(actions);

    var assign = el("div", {class: "chips", role: "group"});
    assign.setAttribute("aria-label", "Assign " + row.title);
    WORKERS.forEach(function (name) {
      var button = actionButton(name, function (pressed) { run(row.id, "assign", name, pressed); });
      if (row.assignee === name) button.setAttribute("aria-pressed", "true");
      assign.appendChild(button);
    });
    li.appendChild(assign);

    var chips = el("div", {class: "chips", role: "group"});
    chips.setAttribute("aria-label", "Comment on " + row.title);
    CHIPS.forEach(function (text) {
      chips.appendChild(actionButton(text, function (button) { run(row.id, "comment", text, button); }));
    });
    li.appendChild(chips);

    if (row.comments && row.comments.length) {
      var notes = el("ul", {class: "notes"});
      row.comments.forEach(function (item) {
        notes.appendChild(el("li", {}, item.text));
      });
      li.appendChild(notes);
    }
    li.appendChild(el("p", {class: "status", role: "status"}));
    return li;
  }

  function actionButton(label, onClick) {
    var button = el("button", {type: "button", class: "act"}, label);
    button.addEventListener("click", function () { onClick(button); });
    return button;
  }

  function renderThreads(payload) {
    var list = document.getElementById("threads");
    if (!list) return;
    var active = document.activeElement;
    var focusCard = active && active.closest ? active.closest("[data-id]") : null;
    var focusLabel = active ? active.textContent : "";
    var focusWas = focusCard ? focusCard.getAttribute("data-id") : "";
    list.textContent = "";
    var rows = payload.threads || [];
    if (!rows.length) {
      list.appendChild(el("li", {}, "No handoffs in this view."));
      return;
    }
    rows.forEach(function (row) { list.appendChild(threadCard(row)); });
    if (focusWas) {
      var card = list.querySelector('[data-id="' + focusWas + '"]');
      if (!card) return;
      var buttons = card.querySelectorAll("button");
      for (var i = 0; i < buttons.length; i++) {
        if (buttons[i].textContent === focusLabel) {
          buttons[i].focus();
          break;
        }
      }
    }
  }

  function showStatus(id, reason) {
    var card = document.querySelector('#threads [data-id="' + id + '"] .status');
    if (!card) return;
    card.textContent = reason;
  }

  function run(id, action, extra, button) {
    var api = window.FloorAdapter;
    if (!api) return;
    var job;
    if (action === "acknowledge") job = api.acknowledge(id);
    else if (action === "escalate") job = api.escalate(id);
    else if (action === "assign") job = api.assign(id, extra);
    else job = api.comment(id, extra);
    if (button) button.setAttribute("aria-busy", "true");
    job.then(function (result) {
      return api.load().then(function (payload) {
        paintBanner(payload);
        renderThreads(payload);
        showStatus(id, result.reason);
        paintCounts(payload);
      });
    }).catch(function () {
      showStatus(id, "That action stayed on this screen and did not finish.");
    });
  }

  function paintCounts(payload) {
    var counts = document.getElementById("key-counts");
    if (!counts) return;
    counts.hidden = true;
    counts.textContent = "";
    if (payload.origin === "redis" && payload.gate === "clear" && payload.key_counts) {
      counts.hidden = false;
      var lines = ["Live key counts"];
      Object.keys(payload.key_counts).forEach(function (name) {
        lines.push(name + ": " + payload.key_counts[name]);
      });
      counts.textContent = lines.join("\n");
    }
  }

  function initConference() {
    if (!document.getElementById("threads") || !window.FloorAdapter) return;
    window.FloorAdapter.load().then(function (payload) {
      paintBanner(payload);
      renderThreads(payload);
      paintCounts(payload);
    }).catch(function () {
      paintBanner({notice: "Sample file did not load.", origin: "sample"});
    });
  }

  ready(function () {
    initDiagrams();
    initDelivery();
    initModel();
    initConference();
  });
})();
