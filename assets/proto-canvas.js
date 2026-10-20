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
   loadCanvasItems(url) is the only read of canvas items. It fetches the JSON
   file today. Render does not know the source, so a later Redis-backed GET
   can replace that function without a change to the drawing code.
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
  function collapsed(value) {
    return String(value || "").replace(/[\u0000-\u0020\u007f]+/g, "");
  }
  function urlAllowed(value) {
    var cleaned = collapsed(value);
    if (!cleaned || cleaned.slice(0, 2) === "//") return false;
    var scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(cleaned);
    if (!scheme) return true;
    var name = scheme[1].toLowerCase();
    return name === "http" || name === "https";
  }
  function badScheme(value) {
    var cleaned = collapsed(value).toLowerCase();
    return cleaned.indexOf("javascript:") !== -1 || cleaned.indexOf("vbscript:") !== -1 || cleaned.indexOf("data:") !== -1;
  }
  function penpotUrl(value) {
    if (!value) return "";
    try {
      var url = new URL(String(value).replace(/^[\u0000-\u0020\u007f]+|[\u0000-\u0020\u007f]+$/g, ""), window.location.href);
      if (url.protocol !== "https:" || url.hostname !== "design.penpot.app") return "";
      if (url.username || url.password) return "";
      return url.href;
    } catch (err) {
      return "";
    }
  }
  var SVG_NS = "http://www.w3.org/2000/svg";
  var HTML_NS = "http://www.w3.org/1999/xhtml";
  var SVG_TAGS = { svg: 1, g: 1, path: 1, rect: 1, circle: 1, ellipse: 1, line: 1, polyline: 1, polygon: 1, text: 1, tspan: 1, textpath: 1, title: 1, desc: 1, defs: 1, use: 1, symbol: 1, marker: 1, lineargradient: 1, radialgradient: 1, stop: 1, clippath: 1, mask: 1, pattern: 1, a: 1, image: 1, style: 1, switch: 1 };
  var HTML_TAGS = { div: 1, span: 1, p: 1, strong: 1, em: 1, b: 1, i: 1, u: 1, br: 1, ul: 1, ol: 1, li: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, table: 1, thead: 1, tbody: 1, tr: 1, th: 1, td: 1, a: 1, small: 1, code: 1, pre: 1, img: 1 };
  function allowedElement(child) {
    var local = (child.localName || child.tagName || "").toLowerCase();
    if (!local || local === "foreignobject" || local.indexOf(":") !== -1) return false;
    var ns = child.namespaceURI || HTML_NS;
    if (ns === SVG_NS) return !!SVG_TAGS[local];
    if (ns === HTML_NS) return !!HTML_TAGS[local];
    return false;
  }
  function stripAttrs(child) {
    if (!child.attributes) return;
    var urlAttr = { href: 1, src: 1, action: 1, formaction: 1, poster: 1, cite: 1, background: 1 };
    for (var a = child.attributes.length - 1; a >= 0; a--) {
      var attr = child.attributes[a];
      var name = (attr.localName || attr.name || "").toLowerCase();
      if (name.indexOf("on") === 0 || name.indexOf(":") !== -1) {
        child.removeAttributeNode(attr);
        continue;
      }
      if (name === "srcset") {
        var parts = String(attr.value || "").split(",");
        var ok = true;
        for (var p = 0; p < parts.length; p++) {
          var token = parts[p].trim().split(/\s+/)[0];
          if (token && !urlAllowed(token)) ok = false;
        }
        if (!ok) child.removeAttributeNode(attr);
        continue;
      }
      if (urlAttr[name]) {
        if (!urlAllowed(attr.value)) child.removeAttributeNode(attr);
        continue;
      }
      if (badScheme(attr.value)) child.removeAttributeNode(attr);
    }
  }
  function stripDanger(node) {
    var nodes = [node];
    if (node.querySelectorAll) {
      var found = node.querySelectorAll("*");
      for (var i = 0; i < found.length; i++) nodes.push(found[i]);
    }
    for (var n = nodes.length - 1; n >= 0; n--) {
      var child = nodes[n];
      if (child !== node && !allowedElement(child)) {
        if (child.parentNode) child.parentNode.removeChild(child);
        continue;
      }
      stripAttrs(child);
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
  function drawMermaid(host, source, stillCurrent) {
    var mine = String(++drawSeq);
    host.setAttribute("data-draw", mine);
    function current() {
      return (!stillCurrent || stillCurrent()) && host.isConnected && host.getAttribute("data-draw") === mine;
    }
    return loadMermaid().then(function (lib) {
      var level = "";
      try { level = lib.mermaidAPI && lib.mermaidAPI.getConfig().securityLevel; } catch (err) { level = ""; }
      if (!mermaidReady || level !== "strict") {
        lib.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "neutral",
          htmlLabels: false,
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
      if (!current()) return;
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
      if (!current()) return;
      host.textContent = "";
      var failed = err && String(err.message || err).indexOf("library") !== -1;
      host.appendChild(el("p", { "class": "pcv-empty" })).textContent = failed ? "Diagram library did not load." : "The diagram text is not ready.";
    });
  }

  function mermaidId(value) {
    var name = String(value || "");
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : "";
  }
  function modelSource(model) {
    var lines = ["erDiagram"];
    (model.objects || []).forEach(function (object) {
      var objectName = mermaidId(object.name);
      if (!objectName) return;
      lines.push("  " + objectName + " {");
      (object.fields || []).forEach(function (field) {
        var fieldName = mermaidId(field.name);
        if (!fieldName) return;
        var type = field.type === "number" ? "float" : (field.type === "boolean" ? "boolean" : "string");
        lines.push("    " + type + " " + fieldName);
      });
      lines.push("  }");
    });
    (model.relationships || []).forEach(function (rel) {
      var from = mermaidId(rel.from);
      var to = mermaidId(rel.to);
      var label = mermaidId(rel.label);
      if (from && to && label) lines.push("  " + from + " }o--|| " + to + " : " + label);
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
    var drawGen = 0;
    function showDraw(item) {
      var gen = ++drawGen;
      var itemId = item && item.id;
      function stillCurrent() {
        return gen === drawGen && itemId === diagramId && !salesforceOn;
      }
      drawA.textContent = "";
      if (!item) return;
      if (item.type === "process" || item.type === "model") {
        var graph = el("div", { "class": "pcv-graph" });
        drawA.appendChild(graph);
        drawMermaid(graph, textOf(item), stillCurrent);
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
      var gen = ++drawGen;
      function stillCurrent() {
        return gen === drawGen && salesforceOn;
      }
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
      drawMermaid(graph, modelSource(org), stillCurrent);
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
      clearTimeout(drawTimer);
      drawTimer = 0;
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
      var read = window.ProtoCanvas && window.ProtoCanvas.loadCanvasItems;
      if (typeof read !== "function") read = loadCanvasItems;
      return read(feedUrl).then(applyFeed).catch(function () {
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
      var itemId = item.id;
      drawTimer = setTimeout(function () {
        if (diagramId !== itemId || salesforceOn) return;
        var fresh = findItem(itemId);
        showDraw(fresh);
        if (fresh && (fresh.type === "logo" || fresh.type === "ui")) showPrototype(fresh.id === protoId ? fresh : findItem(protoId));
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

  function loadCanvasItems(url) {
    if (!url) return Promise.reject(new Error("feed"));
    return fetch(url, { cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error("feed");
      return res.json();
    });
  }

  function boot() {
    var nodes = document.querySelectorAll("[data-proto-canvas]");
    for (var i = 0; i < nodes.length; i++) mount(nodes[i]);
  }
  window.ProtoCanvas = { mount: mount, safeHtml: safeHtml, safeSvg: safeSvg, penpotUrl: penpotUrl, modelSource: modelSource, loadCanvasItems: loadCanvasItems };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
