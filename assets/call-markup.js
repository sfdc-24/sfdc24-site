/* Call markup. Notes stay in this browser. No server and no Redis write. */
(function () {
  "use strict";

  var STORE = "sfdc24-call-notes-2026-10-07";
  var FILE = "call-notes-2026-10-07";
  var AUTHORS = ["", "Mr. Salam", "Claude", "Codex", "Gemini", "Grok", "Cursor"];
  var state = load();
  var originals = {};
  var draftPin = {};
  var renderN = 0;

  function ready(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORE);
      var data = raw ? JSON.parse(raw) : {};
      if (!data || typeof data !== "object") data = {};
      if (!data.diagrams || typeof data.diagrams !== "object") data.diagrams = {};
      return data;
    } catch (err) {
      return {diagrams: {}};
    }
  }

  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify(state));
      return true;
    } catch (err) {
      return false;
    }
  }

  function bucket(id) {
    if (!state.diagrams[id]) state.diagrams[id] = {comments: [], spoken: "", edited: null, editedAt: ""};
    if (!Array.isArray(state.diagrams[id].comments)) state.diagrams[id].comments = [];
    return state.diagrams[id];
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

  function norm(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  function sections() {
    return Array.prototype.slice.call(document.querySelectorAll("[data-call-diagram]"));
  }

  function diagramId(section) {
    return section.getAttribute("data-call-diagram");
  }

  function titleOf(section) {
    var heading = section.querySelector("h2");
    return heading ? norm(heading.textContent) : diagramId(section);
  }

  function sourceBox(section) {
    return section.querySelector("textarea.call-src");
  }

  function ensureSource(section) {
    var box = sourceBox(section);
    if (box) return box;
    var named = section.querySelector("textarea[id$='-src']");
    if (named) {
      named.classList.add("call-src");
      return named;
    }
    box = el("textarea", {class: "call-src", rows: "12", "aria-label": "Diagram text"});
    var pre = section.querySelector(".diagram-src");
    if (pre && pre.textContent) box.value = pre.textContent;
    var wrap = el("div", {class: "call-edit", hidden: "hidden"});
    wrap.appendChild(box);
    wrap.appendChild(el("p", {})).appendChild(redrawButton(section));
    var anchor = section.querySelector(".call-split") || section.querySelector("figure");
    if (anchor && anchor.nextSibling) section.insertBefore(wrap, anchor.nextSibling);
    else section.appendChild(wrap);
    return box;
  }

  function redrawButton(section) {
    var button = el("button", {type: "button", class: "call-btn"}, "Redraw");
    button.addEventListener("click", function () { redraw(section); });
    return button;
  }

  function captureOriginal(section) {
    var id = diagramId(section);
    if (originals[id]) return;
    var box = sourceBox(section);
    var pre = section.querySelector(".diagram-src");
    var text = box && box.value ? box.value : (pre ? pre.textContent : "");
    if (norm(text)) originals[id] = text;
  }

  function applyStoredEdit(section) {
    var id = diagramId(section);
    var item = bucket(id);
    var box = ensureSource(section);
    captureOriginal(section);
    if (item.edited && originals[id] && item.edited !== originals[id]) box.value = item.edited;
  }

  function layout(section) {
    if (section.querySelector(".call-split")) return;
    var figure = section.querySelector("figure");
    if (!figure) return;
    var split = el("div", {class: "call-split"});
    figure.parentNode.insertBefore(split, figure);
    split.appendChild(figure);
    split.appendChild(el("div", {class: "call-panel"}));
    figure.classList.add("call-figure");
  }

  function tools() {
    if (document.getElementById("call-tools")) return;
    var bar = el("div", {id: "call-tools", class: "call-tools"});
    var exp = el("button", {type: "button", class: "call-btn", id: "export-notes"}, "Export notes");
    exp.addEventListener("click", exportNotes);
    var imp = el("button", {type: "button", class: "call-btn"}, "Import");
    var file = el("input", {type: "file", id: "import-notes", accept: "application/json,.json"});
    file.hidden = true;
    file.addEventListener("change", function () {
      var picked = file.files && file.files[0];
      if (picked) importNotes(picked);
      file.value = "";
    });
    imp.addEventListener("click", function () { file.click(); });
    bar.appendChild(exp);
    bar.appendChild(imp);
    bar.appendChild(file);
    bar.appendChild(el("p", {class: "call-hint"}, "Notes stay in this browser. Export writes a markdown file and a JSON file. Nothing is sent to Redis."));
    var host = document.querySelector("main") || document.body;
    var first = sections()[0];
    if (first) host.insertBefore(bar, first);
    else host.appendChild(bar);
  }

  function editToggle(section) {
    if (section.querySelector("[data-edit-toggle]")) return;
    var box = ensureSource(section);
    var wrap = box.closest(".call-edit");
    if (!wrap) {
      wrap = el("div", {class: "call-edit"});
      box.parentNode.insertBefore(wrap, box);
      wrap.appendChild(box);
    }
    if (!wrap.querySelector("button")) wrap.appendChild(redrawButton(section));
    wrap.hidden = true;
    var button = el("button", {type: "button", class: "call-btn", "data-edit-toggle": diagramId(section)}, "Edit diagram text");
    button.addEventListener("click", function () {
      wrap.hidden = !wrap.hidden;
      button.setAttribute("aria-pressed", wrap.hidden ? "false" : "true");
      if (!wrap.hidden) box.focus();
    });
    if (wrap.parentNode) wrap.parentNode.insertBefore(button, wrap);
    else section.appendChild(button);
  }

  function panelOf(section) {
    return section.querySelector(".call-panel");
  }

  function paint(section) {
    var panel = panelOf(section);
    if (!panel) return;
    var id = diagramId(section);
    var item = bucket(id);
    var pin = draftPin[id];
    var previousNote = panel.querySelector(".call-note");
    var previousAuthor = panel.querySelector("select");
    var noteDraft = previousNote ? previousNote.value : "";
    var authorDraft = previousAuthor ? previousAuthor.value : "";
    panel.textContent = "";
    panel.appendChild(el("h3", {}, "Comments"));

    var note = el("textarea", {class: "call-note", rows: "3", "aria-label": "Comment on " + titleOf(section)});
    note.value = noteDraft;
    panel.appendChild(note);

    var author = el("select", {"aria-label": "Author"});
    AUTHORS.forEach(function (name) {
      author.appendChild(el("option", {value: name}, name || "Author optional"));
    });
    if (AUTHORS.indexOf(authorDraft) >= 0) author.value = authorDraft;
    panel.appendChild(author);

    var status = el("p", {class: "call-pin-status"});
    status.textContent = pin ? "Pinned to: " + pin.label : "Whole diagram. Click a node to pin this comment.";
    panel.appendChild(status);
    if (pin) {
      var clear = el("button", {type: "button", class: "call-btn call-btn-quiet"}, "Clear pin");
      clear.addEventListener("click", function () {
        delete draftPin[id];
        paint(section);
      });
      panel.appendChild(clear);
    }

    var add = el("button", {type: "button", class: "call-btn"}, "Add comment");
    add.addEventListener("click", function () {
      var text = norm(note.value);
      if (!text) {
        note.focus();
        return;
      }
      var comment = {
        id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        text: text,
        author: AUTHORS.indexOf(author.value) >= 0 ? author.value : "",
        nodeLabel: pin ? pin.label : "",
        nodeIndex: pin ? pin.index : 0,
        at: new Date().toISOString()
      };
      item.comments.push(comment);
      delete draftPin[id];
      if (!save()) setLive(section, "This browser blocked local storage. Export the notes before leaving.");
      paint(section);
      placeMarkers(section);
    });
    panel.appendChild(add);

    var list = el("ol", {class: "call-list"});
    var number = 0;
    item.comments.forEach(function (comment) {
      var pinned = !!comment.nodeLabel;
      if (pinned) number += 1;
      var li = el("li", {});
      var who = comment.author ? comment.author + " · " : "";
      var where = pinned ? ("#" + number + " · " + comment.nodeLabel) : "Whole diagram";
      li.appendChild(el("p", {class: "call-meta"}, where + " · " + who + stamp(comment.at)));
      li.appendChild(el("p", {class: "call-text"}, comment.text));
      var remove = el("button", {type: "button", class: "call-btn call-btn-quiet"}, "Remove");
      remove.addEventListener("click", function () {
        item.comments = item.comments.filter(function (row) { return row.id !== comment.id; });
        save();
        paint(section);
        placeMarkers(section);
      });
      li.appendChild(remove);
      list.appendChild(li);
    });
    if (item.comments.length) panel.appendChild(list);

    panel.appendChild(el("h3", {}, "Spoken comments"));
    panel.appendChild(el("p", {class: "call-hint"}, "Paste a transcript excerpt. Spoken remarks from the live transcript can be added after the call."));
    var spoken = el("textarea", {class: "call-spoken", rows: "4", "aria-label": "Spoken comments for " + titleOf(section)});
    spoken.value = item.spoken || "";
    spoken.addEventListener("input", function () {
      item.spoken = spoken.value;
      save();
    });
    panel.appendChild(spoken);
    var live = el("p", {class: "call-live", role: "status"});
    panel.appendChild(live);
  }

  function setLive(section, text) {
    var live = section.querySelector(".call-live");
    if (live) live.textContent = text;
  }

  function stamp(iso) {
    try {
      return new Date(iso).toLocaleString("en-US", {
        timeZone: "America/New_York",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZoneName: "short"
      });
    } catch (err) {
      return iso;
    }
  }

  function nodeLabel(node) {
    var copy = node.cloneNode(true);
    copy.querySelectorAll(".call-pin").forEach(function (pin) { pin.remove(); });
    return norm(copy.textContent);
  }

  function findNode(svg, label, index) {
    var want = norm(label);
    var nodes = svg.querySelectorAll(".node");
    var seen = 0;
    for (var i = 0; i < nodes.length; i++) {
      if (nodeLabel(nodes[i]) !== want) continue;
      if (seen === (index || 0)) return nodes[i];
      seen += 1;
    }
    return null;
  }

  function markerHost(section) {
    var svg = section.querySelector("svg");
    if (!svg) return null;
    var host = svg.parentElement;
    if (!host) return null;
    host.style.position = "relative";
    var layer = host.querySelector(":scope > .call-marks");
    if (!layer) {
      layer = el("div", {class: "call-marks"});
      layer.style.cssText = "position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none;";
      host.appendChild(layer);
    }
    return {svg: svg, host: host, layer: layer};
  }

  function placeMarkers(section) {
    var found = markerHost(section);
    if (!found) return;
    found.layer.textContent = "";
    section.querySelectorAll("svg .call-pin").forEach(function (node) { node.remove(); });
    var comments = bucket(diagramId(section)).comments;
    var number = 0;
    var offset = {};
    var hostRect = found.host.getBoundingClientRect();
    comments.forEach(function (comment) {
      if (!comment.nodeLabel) return;
      number += 1;
      var node = findNode(found.svg, comment.nodeLabel, comment.nodeIndex || 0);
      if (!node) return;
      var key = comment.nodeLabel + "#" + (comment.nodeIndex || 0);
      var slot = offset[key] || 0;
      offset[key] = slot + 1;
      var rect = node.getBoundingClientRect();
      var mark = el("span", {class: "call-pin"}, String(number));
      mark.style.cssText = "position:absolute;width:22px;height:22px;border-radius:50%;background:#0A66C2;color:#FFFFFF;font:700 12px/22px Segoe UI,sans-serif;text-align:center;pointer-events:auto;";
      mark.style.left = (rect.right - hostRect.left + found.host.scrollLeft - 11 - slot * 18) + "px";
      mark.style.top = (rect.top - hostRect.top + found.host.scrollTop - 11) + "px";
      found.layer.appendChild(mark);
    });
  }

  function onDiagramClick(section, event) {
    if (event.target.closest(".call-pin")) return;
    var node = event.target.closest(".node");
    if (!node || !section.contains(node)) return;
    var svg = section.querySelector("svg");
    var label = nodeLabel(node);
    var matches = Array.prototype.filter.call(svg.querySelectorAll(".node"), function (item) {
      return nodeLabel(item) === label;
    });
    var index = matches.indexOf(node);
    var id = diagramId(section);
    var current = draftPin[id];
    if (current && current.label === label && current.index === index) delete draftPin[id];
    else draftPin[id] = {label: label, index: index < 0 ? 0 : index};
    paint(section);
  }

  function watch(section) {
    var figure = section.querySelector("figure");
    if (figure && !figure.__callWatch) {
      figure.__callWatch = true;
      figure.addEventListener("click", function (event) { onDiagramClick(section, event); });
      new MutationObserver(function (records) {
        var structural = records.some(function (record) {
          var nodes = Array.prototype.slice.call(record.addedNodes).concat(Array.prototype.slice.call(record.removedNodes));
          return nodes.some(function (node) {
            return !(node.nodeType === 1 && node.classList && node.classList.contains("call-marks"));
          });
        });
        if (structural) placeMarkers(section);
      }).observe(figure, {childList: true});
    }
    var slot = section.querySelector(".diagram-svg");
    if (slot && !slot.__callWatch) {
      slot.__callWatch = true;
      new MutationObserver(function (records) {
        var structural = records.some(function (record) {
          var nodes = Array.prototype.slice.call(record.addedNodes).concat(Array.prototype.slice.call(record.removedNodes));
          return nodes.some(function (node) {
            return !(node.nodeType === 1 && node.classList && node.classList.contains("call-marks"));
          });
        });
        if (structural) placeMarkers(section);
      }).observe(slot, {childList: true});
    }
  }

  function redraw(section) {
    var box = sourceBox(section);
    var text = box ? box.value : "";
    var id = diagramId(section);
    var item = bucket(id);
    item.edited = text && originals[id] && text !== originals[id] ? text : null;
    item.editedAt = item.edited ? new Date().toISOString() : "";
    save();
    var figure = section.querySelector("figure");
    var slot = section.querySelector(".diagram-svg") || figure;
    if (!window.mermaid || !slot) {
      setLive(section, "Diagram text is stored. Redraw needs the diagram library.");
      return;
    }
    if (!window.mermaid.__callMarkup) {
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        flowchart: {htmlLabels: true, wrappingWidth: 220, padding: 16}
      });
      window.mermaid.__callMarkup = true;
    }
    renderN += 1;
    var renderId = "calllive" + renderN;
    window.mermaid.render(renderId, text).then(function (out) {
      slot.innerHTML = out.svg;
      var fallback = section.querySelector(".diagram-fallback");
      if (fallback) fallback.hidden = true;
      placeMarkers(section);
      setLive(section, "Diagram redrawn on this screen.");
    }).catch(function () {
      setLive(section, "That diagram text did not render. The previous picture is unchanged.");
    });
  }

  function diffLines(before, after) {
    var a = String(before || "").replace(/\r\n/g, "\n").split("\n");
    var b = String(after || "").replace(/\r\n/g, "\n").split("\n");
    var n = a.length;
    var m = b.length;
    var dp = [];
    for (var i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
    for (i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    var out = [];
    i = 0;
    j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        out.push(" " + a[i]);
        i += 1;
        j += 1;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push("-" + a[i]);
        i += 1;
      } else {
        out.push("+" + b[j]);
        j += 1;
      }
    }
    while (i < n) { out.push("-" + a[i]); i += 1; }
    while (j < m) { out.push("+" + b[j]); j += 1; }
    return out.join("\n");
  }

  function payload() {
    var diagrams = {};
    sections().forEach(function (section) {
      var id = diagramId(section);
      var item = bucket(id);
      var box = sourceBox(section);
      var current = box ? box.value : "";
      var original = originals[id] || current;
      var changed = !!(item.edited && item.edited !== original);
      diagrams[id] = {
        title: titleOf(section),
        comments: item.comments,
        spoken: item.spoken || "",
        original: original,
        edited: changed ? item.edited : null,
        editedAt: changed ? (item.editedAt || "") : "",
        diff: changed ? diffLines(original, item.edited) : null
      };
    });
    return {
      call: "2026-10-07",
      exported_at: new Date().toISOString(),
      diagrams: diagrams
    };
  }

  function markdown(data) {
    var lines = [
      "# Call notes 2026-10-07",
      "",
      "Taken in the browser while discussing the diagrams. Not a Redis write.",
      ""
    ];
    Object.keys(data.diagrams).forEach(function (id) {
      var diagram = data.diagrams[id];
      lines.push("## " + (diagram.title || id));
      lines.push("");
      var groups = {};
      var order = [];
      (diagram.comments || []).forEach(function (comment) {
        var key = comment.nodeLabel ? comment.nodeLabel : "Whole diagram";
        if (!groups[key]) {
          groups[key] = [];
          order.push(key);
        }
        groups[key].push(comment);
      });
      if (!order.length) {
        lines.push("No written comments.");
        lines.push("");
      }
      order.forEach(function (key) {
        lines.push("### " + key);
        lines.push("");
        groups[key].forEach(function (comment) {
          var who = comment.author ? comment.author : "Author not set";
          lines.push("- " + (comment.at || "") + " — " + who + " — " + comment.text);
        });
        lines.push("");
      });
      lines.push("### Spoken comments");
      lines.push("");
      lines.push(diagram.spoken && diagram.spoken.trim() ? diagram.spoken.trim() : "None.");
      lines.push("");
      lines.push("### Diagram text");
      lines.push("");
      if (diagram.diff) {
        lines.push("Edit made during the discussion:");
        lines.push("");
        lines.push("```diff");
        lines.push(diagram.diff);
        lines.push("```");
      } else {
        lines.push("Unchanged from the committed diagram text.");
      }
      lines.push("");
    });
    return lines.join("\n");
  }

  function download(name, text, type) {
    var blob = new Blob([text], {type: type});
    var link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
  }

  function exportNotes() {
    sections().forEach(captureOriginal);
    var data = payload();
    download(FILE + ".md", markdown(data), "text/markdown");
    setTimeout(function () {
      download(FILE + ".json", JSON.stringify(data, null, 2) + "\n", "application/json");
    }, 400);
  }

  function cleanComment(row) {
    if (!row || typeof row !== "object") return null;
    var text = norm(row.text);
    if (!text || !row.id) return null;
    var author = AUTHORS.indexOf(row.author) >= 0 ? row.author : "";
    return {
      id: String(row.id),
      text: text,
      author: author,
      nodeLabel: norm(row.nodeLabel),
      nodeIndex: Number(row.nodeIndex) || 0,
      at: typeof row.at === "string" ? row.at : new Date().toISOString()
    };
  }

  function mergeSpoken(current, incoming) {
    current = current || "";
    incoming = String(incoming || "");
    if (!incoming.trim()) return current;
    if (!current.trim()) return incoming;
    if (current.indexOf(incoming.trim()) !== -1) return current;
    return current.replace(/\s+$/, "") + "\n\n" + incoming.trim();
  }

  function importNotes(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try {
        data = JSON.parse(String(reader.result || ""));
      } catch (err) {
        var bar = document.querySelector(".call-hint");
        if (bar) bar.textContent = "Import the JSON export. The markdown file is for reading.";
        return;
      }
      if (!data || typeof data.diagrams !== "object") return;
      var touched = [];
      Object.keys(data.diagrams).forEach(function (id) {
        var incoming = data.diagrams[id];
        if (!incoming || typeof incoming !== "object") return;
        var item = bucket(id);
        var seen = {};
        item.comments.forEach(function (comment) { seen[comment.id] = comment; });
        (incoming.comments || []).forEach(function (row) {
          var comment = cleanComment(row);
          if (comment && !seen[comment.id]) {
            seen[comment.id] = comment;
            item.comments.push(comment);
          }
        });
        item.comments.sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); });
        item.spoken = mergeSpoken(item.spoken, incoming.spoken);
        if (incoming.edited && incoming.edited !== incoming.original) {
          var newer = !item.editedAt || String(incoming.editedAt || "") >= String(item.editedAt || "");
          if (newer) {
            item.edited = String(incoming.edited);
            item.editedAt = incoming.editedAt || new Date().toISOString();
          }
        }
        touched.push(id);
      });
      save();
      sections().forEach(function (section) {
        var id = diagramId(section);
        if (touched.indexOf(id) === -1) return;
        applyStoredEdit(section);
        paint(section);
        placeMarkers(section);
        if (bucket(id).edited) redraw(section);
      });
    };
    reader.readAsText(file);
  }

  function bootSection(section) {
    layout(section);
    ensureSource(section);
    editToggle(section);
    applyStoredEdit(section);
    paint(section);
    watch(section);
    placeMarkers(section);
    var pre = section.querySelector(".diagram-src");
    if (pre && !pre.__callWatch) {
      pre.__callWatch = true;
      new MutationObserver(function () {
        captureOriginal(section);
        var box = sourceBox(section);
        var id = diagramId(section);
        if (box && !box.value && originals[id] && !bucket(id).edited) box.value = originals[id];
        applyStoredEdit(section);
      }).observe(pre, {childList: true, characterData: true, subtree: true});
    }
  }

  ready(function () {
    if (!sections().length) return;
    tools();
    sections().forEach(bootSection);
    window.addEventListener("resize", function () {
      sections().forEach(placeMarkers);
    });
  });
})();
