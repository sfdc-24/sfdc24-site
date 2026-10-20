/* Prototyping canvas. No host brand names. Colors come from the host
   page through --ink, --paper, --accent, --mute, --soft, and --ui.

   Mount:
     <div data-proto-canvas data-started="0"
          data-feed="/data/proto-canvas.json"
          data-org="/data/proto-org-model.json" hidden></div>
     <link rel="stylesheet" href="/assets/proto-canvas.css">
     <script src="/assets/proto-canvas.js" defer></script>
   Set data-started to "1" when the conference starts. The module renders
   then and polls the feed.

   Feed format proto-canvas/1:
     { read_at, public_status, items: [{ id, set, set_label, type, title,
       horizon, status, example, by, source, penpot }] }
   type: process | model | logo | ui
   status: wip | review | approved   (approved is locked)
   horizon: current | future
   penpot: an https://design.penpot.app/ URL, or empty.
   example true marks a starter. Leave it true unless an agent posted the item.

   Org file, used by the Salesforce action:
     { live, snapshot, generated, caveat, objects:[{name, fields:[{name,type}]}],
       relationships:[{from, to, label}], relationship_note }
   The diagram library is loaded only after start, and only from this module.
*/
(function () {
  var MERMAID_SRC = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js";
  var MERMAID_SRI = "sha384-rbtjAdnIQE/aQJGEgXrVUlMibdfTSa4PQju4HDhN3sR2PmaKFzhEafuePsl9H/9I";
  var STATUS = { wip: "WIP", review: "In review", approved: "Approved" };
  var HORIZON = { current: "Current", future: "Future" };
  var POLL_MS = 12000;
  var editsKey = "proto-canvas-edits";
  var requestsKey = "proto-canvas-requests";

  function el(tag, attrs) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (attrs[key] != null) node.setAttribute(key, attrs[key]);
      });
    }
    return node;
  }
  function readStore(key) {
    try {
      var raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : {};
    } catch (err) {
      return {};
    }
  }
  function writeStore(key, value) {
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch (err) {}
  }
  function penpotUrl(value) {
    if (!value) return "";
    try {
      var url = new URL(String(value), window.location.href);
      if (url.protocol !== "https:" || url.hostname !== "design.penpot.app") return "";
      return url.href;
    } catch (err) {
      return "";
    }
  }
  function stripDanger(node) {
    var drop = { script: 1, iframe: 1, object: 1, embed: 1, link: 1 };
    var all = node.querySelectorAll ? node.querySelectorAll("*") : [];
    for (var i = all.length - 1; i >= 0; i--) {
      var child = all[i];
      if (drop[child.tagName.toLowerCase()]) {
        child.remove();
        continue;
      }
      for (var a = child.attributes.length - 1; a >= 0; a--) {
        var name = child.attributes[a].name;
        var val = child.attributes[a].value || "";
        if (/^on/i.test(name) || /^javascript:/i.test(val)) child.removeAttribute(name);
      }
    }
  }
  function safeSvg(text) {
    var doc;
    try { doc = new DOMParser().parseFromString(text, "image/svg+xml"); }
    catch (err) { return null; }
    var root = doc.documentElement;
    if (!root || root.nodeName.toLowerCase() !== "svg" || root.querySelector("parsererror")) return null;
    stripDanger(root);
    return document.importNode(root, true);
  }
  function safeHtml(text) {
    var doc = new DOMParser().parseFromString("<div id='pcv-root'>" + text + "</div>", "text/html");
    var root = doc.getElementById("pcv-root");
    if (!root) return "";
    stripDanger(root);
    return root.innerHTML;
  }

  var mermaidPromise = null;
  function loadMermaid() {
    if (window.mermaid && typeof window.mermaid.render === "function") return Promise.resolve(window.mermaid);
    if (mermaidPromise) return mermaidPromise;
    mermaidPromise = new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = MERMAID_SRC;
      script.integrity = MERMAID_SRI;
      script.crossOrigin = "anonymous";
      script.async = true;
      script.setAttribute("data-proto-mermaid", "");
      script.onload = function () {
        if (window.mermaid && typeof window.mermaid.render === "function") resolve(window.mermaid);
        else reject(new Error("library"));
      };
      script.onerror = function () { reject(new Error("library")); };
      document.head.appendChild(script);
    });
    return mermaidPromise;
  }

  var mermaidReady = false;
  var mermaidQueue = Promise.resolve();
  var drawSeq = 0;
  function drawMermaid(host, source) {
    var mine = String(++drawSeq);
    host.setAttribute("data-draw", mine);
    return loadMermaid().then(function (lib) {
      if (!mermaidReady) {
        lib.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "neutral",
          flowchart: { htmlLabels: false, useMaxWidth: true },
          er: { useMaxWidth: true }
        });
        mermaidReady = true;
      }
      var id = "pcvsvg" + mine;
      mermaidQueue = mermaidQueue.then(function () {
        return lib.render(id, source);
      }, function () {
        return lib.render(id, source);
      });
      return mermaidQueue;
    }).then(function (out) {
      if (host.getAttribute("data-draw") !== mine) return;
      var raw = out && out.svg ? out.svg : "";
      host.textContent = "";
      host.setAttribute("data-draw", mine);
      if (/Syntax error/.test(raw) || /class="error-icon"/.test(raw)) {
        host.appendChild(el("p", { "class": "pcv-empty" })).textContent = "The diagram text is not ready.";
        return;
      }
      var svg = safeSvg(raw);
      if (!svg) {
        host.appendChild(el("p", { "class": "pcv-empty" })).textContent = "The diagram text did not draw.";
        return;
      }
      host.appendChild(svg);
    }).catch(function (err) {
      if (host.getAttribute("data-draw") !== mine) return;
      host.textContent = "";
      var failed = err && String(err.message || err).indexOf("library") !== -1;
      host.appendChild(el("p", { "class": "pcv-empty" })).textContent = failed ? "Diagram library did not load." : "The diagram text is not ready.";
    });
  }

  function modelSource(model) {
    var lines = ["erDiagram"];
    (model.objects || []).forEach(function (object) {
      lines.push("  " + object.name + " {");
      (object.fields || []).forEach(function (field) {
        var type = field.type === "number" ? "float" : (field.type === "boolean" ? "boolean" : "string");
        lines.push("    " + type + " " + field.name);
      });
      lines.push("  }");
    });
    (model.relationships || []).forEach(function (rel) {
      lines.push("  " + rel.from + " }o--|| " + rel.to + " : " + rel.label);
    });
    return lines.join("\n");
  }

  function mount(root) {
    if (!root || root.getAttribute("data-proto-mounted") === "1") return;
    root.setAttribute("data-proto-mounted", "1");
    var feedUrl = root.getAttribute("data-feed") || "";
    var orgUrl = root.getAttribute("data-org") || "";
    var bar = el("div", { "class": "pcv-bar", role: "tablist", "aria-label": "Diagram sets" });
    var salesforceBtn = el("button", { type: "button", "aria-pressed": "false" });
    salesforceBtn.textContent = "Salesforce";
    var diagramBtn = el("button", { type: "button", "class": "pcv-pane-toggle", "aria-pressed": "true" });
    diagramBtn.textContent = "Diagram";
    var protoBtn = el("button", { type: "button", "class": "pcv-pane-toggle", "aria-pressed": "false" });
    protoBtn.textContent = "Prototype";
    var note = el("p", { "class": "pcv-note", role: "status" });
    var split = el("div", { "class": "pcv-split", "data-pane": "a" });
    var paneA = el("section", { "class": "pcv-pane pcv-a", "aria-label": "Diagram" });
    var paneB = el("section", { "class": "pcv-pane pcv-b", "aria-label": "Prototype" });
    var headA = el("div", { "class": "pcv-pane-h" });
    var titleA = el("h2");
    var metaA = el("div", { "class": "pcv-sub" });
    var source = el("textarea", { "class": "pcv-source", "aria-label": "Diagram text", spellcheck: "false" });
    var drawA = el("div", { "class": "pcv-draw" });
    var headB = el("div", { "class": "pcv-pane-h" });
    var titleB = el("h2");
    titleB.textContent = "Prototype";
    var drawB = el("div", { "class": "pcv-draw" });
    headA.appendChild(titleA);
    headA.appendChild(metaA);
    paneA.appendChild(headA);
    paneA.appendChild(source);
    paneA.appendChild(drawA);
    headB.appendChild(titleB);
    paneB.appendChild(headB);
    paneB.appendChild(drawB);
    split.appendChild(paneA);
    split.appendChild(paneB);
    root.appendChild(bar);
    root.appendChild(note);
    root.appendChild(split);

    var feed = null;
    var org = null;
    var setKey = "";
    var diagramId = "";
    var protoId = "";
    var salesforceOn = false;
    var protoStamp = "";
    var edits = readStore(editsKey);
    var requests = readStore(requestsKey);
    if (!Array.isArray(requests)) requests = [];
    var timer = 0;

    function started() {
      return root.getAttribute("data-started") === "1";
    }
    function items() {
      return feed && Array.isArray(feed.items) ? feed.items : [];
    }
    function sets() {
      var order = [];
      var map = {};
      items().forEach(function (item) {
        var key = item.set || item.id;
        if (!map[key]) {
          map[key] = [];
          order.push(key);
        }
        map[key].push(item);
      });
      return { order: order, map: map };
    }
    function findItem(id) {
      var list = items();
      for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
      return null;
    }
    function textOf(item) {
      if (!item) return "";
      if (item.status === "approved") return item.source || "";
      if (Object.prototype.hasOwnProperty.call(edits, item.id)) return edits[item.id];
      return item.source || "";
    }
    function badges(host, item) {
      host.textContent = "";
      if (!item) return;
      var status = el("span", { "class": "pcv-badge" });
      status.textContent = STATUS[item.status] || "Unmarked";
      var horizon = el("span", { "class": "pcv-chip" });
      horizon.textContent = HORIZON[item.horizon] || "";
      var who = el("span", { "class": "pcv-by" });
      who.textContent = item.by ? "Posted by " + item.by : "";
      host.appendChild(status);
      if (horizon.textContent) host.appendChild(horizon);
      if (item.example) {
        var example = el("span", { "class": "pcv-chip" });
        example.textContent = "Example";
        host.appendChild(example);
      }
      if (who.textContent) host.appendChild(who);
    }
    function paintBar() {
      bar.textContent = "";
      var grouped = sets();
      grouped.order.forEach(function (key) {
        var group = grouped.map[key];
        var button = el("button", { type: "button", role: "tab" });
        button.textContent = (group[0] && group[0].set_label) || key;
        button.setAttribute("aria-selected", !salesforceOn && key === setKey ? "true" : "false");
        button.addEventListener("click", function () {
          salesforceOn = false;
          setKey = key;
          diagramId = "";
          protoId = "";
          render();
        });
        bar.appendChild(button);
      });
      salesforceBtn.setAttribute("aria-pressed", salesforceOn ? "true" : "false");
      bar.appendChild(salesforceBtn);
      bar.appendChild(diagramBtn);
      bar.appendChild(protoBtn);
    }
    function choose(group) {
      var diagrams = group.filter(function (item) { return item.type === "process" || item.type === "model"; });
      var protos = group.filter(function (item) { return item.type === "ui" || item.type === "logo"; });
      function belongs(id, group) {
        for (var i = 0; i < group.length; i++) if (group[i].id === id) return true;
        return false;
      }
      if (!belongs(diagramId, group)) diagramId = diagrams.length ? diagrams[0].id : (group[0] ? group[0].id : "");
      if (!belongs(protoId, group)) protoId = protos.length ? protos[0].id : "";
      return { diagrams: diagrams, protos: protos };
    }
    function clearPicks() {
      var picks = root.querySelectorAll(".pcv-pick");
      for (var i = picks.length - 1; i >= 0; i--) picks[i].remove();
    }
    function subRow(after, list, current, pick) {
      if (list.length < 2) return;
      var row = el("div", { "class": "pcv-sub pcv-pick", role: "group" });
      list.forEach(function (item) {
        var button = el("button", { type: "button" });
        button.textContent = item.title || item.id;
        button.setAttribute("aria-pressed", item.id === current ? "true" : "false");
        button.addEventListener("click", function () { pick(item.id); render(); });
        row.appendChild(button);
      });
      after.parentNode.insertBefore(row, after.nextSibling);
    }
    function showSource(item) {
      source.value = textOf(item);
      var locked = !item || item.status === "approved";
      source.readOnly = locked;
      source.setAttribute("aria-readonly", locked ? "true" : "false");
    }
    function showDraw(item) {
      drawA.textContent = "";
      if (!item) return;
      if (item.type === "process" || item.type === "model") {
        var graph = el("div", { "class": "pcv-graph" });
        drawA.appendChild(graph);
        drawMermaid(graph, textOf(item));
        return;
      }
      if (item.type === "logo") {
        var svg = safeSvg(textOf(item));
        if (svg) drawA.appendChild(svg);
        else drawA.appendChild(el("p", { "class": "pcv-empty" })).textContent = "The mark text is not an SVG.";
      }
    }
    function showPrototype(item) {
      var stamp = item ? item.id + "\n" + textOf(item) + "\n" + (item.penpot || "") : "";
      if (stamp === protoStamp && drawB.childElementCount) return;
      protoStamp = stamp;
      drawB.textContent = "";
      titleB.textContent = item ? (item.title || "Prototype") : "Prototype";
      if (!item) {
        drawB.appendChild(el("p", { "class": "pcv-empty" })).textContent = "This set has no prototype.";
        return;
      }
      var embed = penpotUrl(item.penpot);
      if (item.type === "ui" && !embed) {
        var line = el("p", { "class": "pcv-empty" });
        line.textContent = "No Penpot file is published.";
        drawB.appendChild(line);
      }
      if (embed) {
        var frame = el("iframe", {
          "class": "pcv-frame",
          title: "Penpot prototype",
          sandbox: "allow-scripts allow-same-origin allow-popups allow-forms",
          referrerpolicy: "no-referrer",
          src: embed
        });
        drawB.appendChild(frame);
      }
      if (item.type === "logo") {
        var svg = safeSvg(textOf(item));
        if (svg) drawB.appendChild(svg);
        else drawB.appendChild(el("p", { "class": "pcv-empty" })).textContent = "The mark text is not an SVG.";
        return;
      }
      var wire = el("iframe", { "class": "pcv-wire", title: "Wireframe", sandbox: "" });
      wire.srcdoc = "<!DOCTYPE html><meta charset='utf-8'><title>Wireframe</title>" + safeHtml(item.type === "ui" ? textOf(item) : "<p>Wireframe fallback.</p>");
      drawB.appendChild(wire);
    }
    function showSalesforce() {
      titleA.textContent = "Org data model";
      metaA.textContent = "";
      var snap = el("span", { "class": "pcv-chip" });
      snap.textContent = "Snapshot";
      metaA.appendChild(snap);
      source.hidden = true;
      drawA.textContent = "";
      if (!org || !org.objects) {
        drawA.appendChild(el("p", { "class": "pcv-empty" })).textContent = orgUrl ? "Org snapshot did not load." : "No org snapshot URL.";
        return;
      }
      var caveat = el("p", { "class": "pcv-empty" });
      caveat.textContent = (org.live ? "Live. " : "Not live. ") + (org.caveat || "Snapshot.");
      if (org.generated) caveat.textContent += " Taken " + org.generated + ".";
      drawA.appendChild(caveat);
      var graph = el("div", { "class": "pcv-graph" });
      drawA.appendChild(graph);
      drawMermaid(graph, modelSource(org));
      var list = el("ul", { "class": "pcv-fields" });
      org.objects.forEach(function (object) {
        var row = el("li");
        var name = el("strong");
        name.textContent = object.name;
        row.appendChild(name);
        var fields = el("span");
        fields.textContent = (object.fields || []).map(function (field) { return field.name; }).join(", ");
        row.appendChild(fields);
        list.appendChild(row);
      });
      drawA.appendChild(list);
      if (org.relationship_note) {
        var rel = el("p", { "class": "pcv-empty" });
        rel.textContent = org.relationship_note;
        drawA.appendChild(rel);
      }
      var form = el("div", { "class": "pcv-request" });
      var objectLabel = el("label");
      objectLabel.textContent = "Object";
      objectLabel.setAttribute("for", "pcv-object");
      var objectPick = el("select", { id: "pcv-object" });
      (org.objects || []).forEach(function (object) {
        var option = el("option");
        option.value = object.name;
        option.textContent = object.name;
        objectPick.appendChild(option);
      });
      var changeLabel = el("label");
      changeLabel.textContent = "Change";
      changeLabel.setAttribute("for", "pcv-change");
      var change = el("input", { id: "pcv-change", type: "text", maxlength: "200" });
      var save = el("button", { type: "button" });
      save.textContent = "Save request";
      var saved = el("p", { "class": "pcv-empty", role: "status" });
      saved.textContent = "Saved in this browser. Not sent to the org.";
      var savedList = el("ul", { "class": "pcv-requests" });
      function paintRequests() {
        savedList.textContent = "";
        requests.forEach(function (row) {
          var item = el("li");
          item.textContent = row.object + ": " + row.change + " — WIP";
          savedList.appendChild(item);
        });
      }
      save.addEventListener("click", function () {
        var text = change.value.replace(/\s+/g, " ").trim();
        if (!text) {
          saved.textContent = "Write the change first. Nothing was saved.";
          return;
        }
        requests.unshift({ object: objectPick.value, change: text, at: new Date().toISOString() });
        writeStore(requestsKey, requests);
        change.value = "";
        saved.textContent = "Saved in this browser. Not sent to the org.";
        paintRequests();
      });
      form.appendChild(objectLabel);
      form.appendChild(objectPick);
      form.appendChild(changeLabel);
      form.appendChild(change);
      form.appendChild(save);
      form.appendChild(saved);
      form.appendChild(savedList);
      drawA.appendChild(form);
      paintRequests();
    }
    function render() {
      if (!started()) return;
      root.hidden = false;
      clearPicks();
      paintBar();
      diagramBtn.setAttribute("aria-pressed", split.getAttribute("data-pane") !== "b" ? "true" : "false");
      protoBtn.setAttribute("aria-pressed", split.getAttribute("data-pane") === "b" ? "true" : "false");
      if (feed && feed.public_status === "examples") note.textContent = "Starter diagrams are examples.";
      else if (feed) note.textContent = feed.read_at ? "Feed read " + feed.read_at + "." : "";
      if (salesforceOn) {
        if (!drawA.querySelector(".pcv-request") && !drawA.querySelector(".pcv-fields")) showSalesforce();
        showPrototype(findItem(protoId));
        return;
      }
      source.hidden = false;
      var grouped = sets();
      var group = grouped.map[setKey] || [];
      if (!group.length && grouped.order.length) {
        setKey = grouped.order[0];
        group = grouped.map[setKey];
      }
      var picked = choose(group);
      var diagram = findItem(diagramId);
      titleA.textContent = diagram ? (diagram.title || "Diagram") : "Diagram";
      badges(metaA, diagram);
      subRow(headA, picked.diagrams.length ? picked.diagrams : group, diagramId, function (id) { diagramId = id; });
      subRow(headB, picked.protos, protoId, function (id) { protoId = id; });
      showSource(diagram);
      showDraw(diagram);
      showPrototype(findItem(protoId));
    }
    function applyFeed(next) {
      feed = next;
      if (!setKey) {
        var grouped = sets();
        setKey = grouped.order[0] || "";
      }
      render();
    }
    function loadFeed() {
      if (!feedUrl) {
        note.textContent = "No feed URL.";
        return Promise.resolve();
      }
      return fetch(feedUrl, { cache: "no-store" }).then(function (res) {
        if (!res.ok) throw new Error("feed");
        return res.json();
      }).then(applyFeed).catch(function () {
        note.textContent = "Feed missing.";
      });
    }
    function loadOrg() {
      if (!orgUrl) return Promise.resolve();
      return fetch(orgUrl, { cache: "no-store" }).then(function (res) {
        if (!res.ok) throw new Error("org");
        return res.json();
      }).then(function (data) {
        org = data;
        if (salesforceOn) render();
      }).catch(function () {
        org = null;
      });
    }
    function activate() {
      if (!started()) {
        root.hidden = true;
        if (timer) { clearInterval(timer); timer = 0; }
        return;
      }
      root.hidden = false;
      loadFeed();
      loadOrg();
      if (!timer) timer = setInterval(loadFeed, POLL_MS);
    }

    var drawTimer = 0;
    source.addEventListener("input", function () {
      var item = findItem(diagramId);
      if (!item || item.status === "approved" || salesforceOn) return;
      edits[item.id] = source.value;
      writeStore(editsKey, edits);
      clearTimeout(drawTimer);
      drawTimer = setTimeout(function () {
        showDraw(item);
        if (item.type === "logo" || item.type === "ui") showPrototype(item.id === protoId ? item : findItem(protoId));
      }, 450);
    });
    salesforceBtn.addEventListener("click", function () {
      salesforceOn = !salesforceOn;
      render();
    });
    diagramBtn.addEventListener("click", function () {
      split.setAttribute("data-pane", "a");
      render();
    });
    protoBtn.addEventListener("click", function () {
      split.setAttribute("data-pane", "b");
      render();
    });

    if (window.MutationObserver) {
      new MutationObserver(activate).observe(root, { attributes: true, attributeFilter: ["data-started"] });
    }
    activate();
  }

  function boot() {
    var nodes = document.querySelectorAll("[data-proto-canvas]");
    for (var i = 0; i < nodes.length; i++) mount(nodes[i]);
  }
  window.ProtoCanvas = { mount: mount };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
