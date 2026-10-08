/* Prospect view. Open with ?demo=1. One label. No live system. */
(function () {
  "use strict";

  if (!/(?:^|[?&])demo=1(?:&|$)/.test(location.search || "")) return;

  var LABEL = "Illustration for this conversation.";
  var DOC = "Assessment, then the automation scope, then the locked outline.";
  var LINES = [
    ["Client", "The renewal desk still waits on someone to turn the last call into an assessment."],
    ["Claude", "The agenda is the handoff. The client should leave with an owner and a receipt."],
    ["Greg", "Stay on the decision. What does the client hold tomorrow?"],
    ["Jenny", "One board. Who has the work, and the receipt when it lands."],
    ["Cody", "The assessment outline is on the board."],
    ["Aya", "The outline is reviewed. It can be locked."]
  ];
  var PEOPLE = [
    ["Claude", "Chair. Sets the agenda"],
    ["Greg", "Keeps the pace"],
    ["Aya", "Reviews the work"],
    ["Jenny", "Shapes the experience"],
    ["Cody", "Builds"]
  ];
  var TASKS = [
    ["Assessment outline", "Claude", "Receipt", "Delivered. The client file has the outline."],
    ["Automation for the renewal desk", "Cody", "In progress", "Acknowledged. The scope is being written."],
    ["Who owns the next step", "Jenny", "Asked", "Requested. Waiting on the outline to lock."],
    ["Check before it is locked", "Aya", "Receipt", "Reviewed. Ready for approval."]
  ];

  document.documentElement.classList.add("demo-mode");
  var strip = document.getElementById("sfdc24-staging-banner");
  if (strip) strip.remove();
  var conference = !!document.getElementById("threads");
  document.querySelectorAll("[data-call-diagram], #call-tools, #threads, .note").forEach(function (node) {
    if (node.parentNode) node.parentNode.removeChild(node);
  });

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

  function hashText(text) {
    var s = String(text || "");
    function fnv(seed) {
      var h = seed >>> 0;
      for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return (h >>> 0).toString(16).padStart(8, "0");
    }
    return fnv(2166136261) + fnv((2166136261 ^ s.length) >>> 0);
  }

  function stampDate(iso) {
    try {
      return new Date(iso).toLocaleString("en-US", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "short",
        day: "numeric"
      });
    } catch (err) {
      return iso;
    }
  }

  function lockBanner() {
    var banner = document.getElementById("floor-banner") || document.querySelector(".banner");
    if (!banner) return;
    banner.dataset.demoLock = "1";
    banner.textContent = LABEL;
  }

  function rel(path) {
    return new URL(path, location.href).href;
  }

  function retargetNav() {
    var links = document.querySelectorAll(".floor-nav a");
    links.forEach(function (link) {
      var label = (link.textContent || "").trim();
      if (label === "Conference") link.href = rel("../floor-conference/index.html?demo=1");
      else if (label === "Floor") link.href = rel("../floor/index.html?demo=1");
      else link.href = rel("../floor/index.html?demo=1#demo-floor-story");
    });
  }

  function paintFloor() {
    var lede = document.querySelector(".lede");
    if (lede) lede.textContent = "One place for assessment, automation, and AI enablement. The room, the board, and the document that gets locked.";
    var cards = document.querySelectorAll(".navcards a");
    var copy = [
      ["The work", "Assessment, automation, and AI enablement, held as one sequence."],
      ["The board", "Tasks and receipts. Who has the work, and what came back."],
      ["The handoff", "Asked, accepted, and closed, with a person on the escalation."],
      ["The conference", "The room, the transcript, and the document that gets locked."]
    ];
    cards.forEach(function (link, index) {
      var strong = link.querySelector("strong");
      var span = link.querySelector("span");
      if (copy[index] && strong && span) {
        strong.textContent = copy[index][0];
        span.textContent = copy[index][1];
      }
      if (index === 3) link.href = rel("../floor-conference/index.html?demo=1");
      else link.href = "#demo-floor-story";
    });
    if (!document.getElementById("demo-floor-story")) {
      var story = el("section", {id: "demo-floor-story", class: "card"});
      story.appendChild(el("h2", {}, "What the conference shows"));
      story.appendChild(el("p", {}, "Agents stay in the room. A transcript keeps what was said. The board shows the task and the receipt. The outline moves from a working copy, to review, to a lock."));
      var go = el("a", {class: "demo-go", href: rel("../floor-conference/index.html?demo=1")}, "Open the conference");
      story.appendChild(go);
      var nav = document.querySelector(".navcards");
      if (nav && nav.parentNode) nav.parentNode.insertBefore(story, nav.nextSibling);
    }
  }

  function peopleList() {
    var ul = el("ul", {class: "demo-people"});
    PEOPLE.forEach(function (pair) {
      var li = el("li", {class: "demo-person"});
      li.appendChild(el("strong", {}, pair[0]));
      var role = el("span", {});
      role.appendChild(el("i", {class: "demo-dot", "aria-hidden": "true"}));
      role.appendChild(document.createTextNode(pair[1]));
      li.appendChild(role);
      ul.appendChild(li);
    });
    return ul;
  }

  function boardList() {
    var ul = el("ul", {class: "demo-board"});
    TASKS.forEach(function (row) {
      var li = el("li", {});
      li.appendChild(el("h3", {}, row[0]));
      li.appendChild(el("p", {class: "demo-meta"}, row[1] + " · " + row[2]));
      li.appendChild(el("p", {class: row[2] === "Receipt" ? "demo-receipt" : "demo-meta"}, row[3]));
      ul.appendChild(li);
    });
    return ul;
  }

  function paintConference() {
    var lede = document.querySelector(".lede");
    if (lede) lede.textContent = "The room for assessment, automation, and AI enablement. Prospects watch. The work stays on the board.";
    var main = document.querySelector("main");
    var nav = document.querySelector(".floor-nav");
    if (!main || document.getElementById("demo-story")) return;

    var story = el("div", {id: "demo-story", class: "demo-story"});

    var room = el("section", {class: "card", "aria-label": "In the room"});
    room.appendChild(el("h2", {}, "In the room"));
    room.appendChild(peopleList());
    story.appendChild(room);

    var talk = el("section", {class: "card demo-transcript", "aria-label": "Transcript"});
    talk.appendChild(el("h2", {}, "Transcript"));
    var lines = el("ol", {id: "demo-lines", "aria-live": "polite"});
    talk.appendChild(lines);
    story.appendChild(talk);

    var board = el("section", {class: "card", "aria-label": "Work board"});
    board.appendChild(el("h2", {}, "Work board"));
    board.appendChild(el("p", {class: "demo-meta"}, "Tasks and receipts."));
    board.appendChild(boardList());
    story.appendChild(board);

    var doc = el("section", {id: "demo-doc", class: "card", "aria-label": "Assessment outline"});
    doc.appendChild(el("h2", {}, "Assessment outline"));
    doc.appendChild(el("p", {id: "demo-badge", class: "call-badge"}, "Working copy"));
    doc.appendChild(el("p", {id: "demo-held", class: "call-stamp", hidden: "hidden"}));
    var flow = el("ol", {class: "demo-flow"});
    ["First conversation", "Assessment", "Automation scope"].forEach(function (step) {
      flow.appendChild(el("li", {class: "demo-step"}, step));
    });
    doc.appendChild(flow);
    doc.appendChild(el("p", {id: "demo-note", class: "demo-meta"}, DOC));
    var review = el("button", {type: "button", class: "call-btn", id: "demo-review"}, "Request review");
    var approve = el("button", {type: "button", class: "call-btn", id: "demo-approve", hidden: "hidden"}, "Approve and lock");
    var again = el("button", {type: "button", class: "call-btn call-btn-quiet", id: "demo-new"}, "Start new working copy");
    doc.appendChild(review);
    doc.appendChild(approve);
    doc.appendChild(again);
    story.appendChild(doc);

    var anchor = document.getElementById("floor-banner") || nav;
    if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(story, anchor.nextSibling);
    else main.appendChild(story);

    var phase = "working";
    var version = 1;
    var lockedStamp = "";

    function badge() { return document.getElementById("demo-badge"); }
    function held() { return document.getElementById("demo-held"); }
    function note() { return document.getElementById("demo-note"); }

    function showWorking() {
      phase = "working";
      badge().className = "call-badge";
      badge().textContent = "Working copy";
      note().textContent = version === 1 ? DOC : "Working copy v" + version + ". The locked version stays as it was.";
      review.hidden = false;
      approve.hidden = true;
    }

    review.addEventListener("click", function () {
      if (phase !== "working") return;
      phase = "review";
      badge().className = "call-badge call-badge-review";
      badge().textContent = "In review";
      note().textContent = "Edits are frozen. Reviewer: Aya. Comments can still land.";
      review.hidden = true;
      approve.hidden = false;
    });

    approve.addEventListener("click", function () {
      if (phase !== "review") return;
      phase = "approved";
      var when = new Date().toISOString();
      lockedStamp = "Reviewed by Aya, Approved by Mr. Salam, v" + version + ", " + stampDate(when) + ", " + hashText(DOC + " v" + version);
      badge().className = "call-badge call-badge-approved";
      badge().textContent = "Approved and locked";
      held().hidden = false;
      held().textContent = lockedStamp;
      note().textContent = "This version does not change.";
      approve.hidden = true;
    });

    again.addEventListener("click", function () {
      if (phase === "working" || phase === "review") {
        window.alert("This outline already has a working copy. Only one working copy is allowed.");
        return;
      }
      version += 1;
      showWorking();
    });

    var shown = 0;
    function tick() {
      if (shown >= LINES.length) return;
      var pair = LINES[shown];
      shown += 1;
      lines.appendChild(el("li", {}, pair[0] + " — " + pair[1]));
      lines.scrollTop = lines.scrollHeight;
      if (shown < LINES.length) setTimeout(tick, 4000);
    }
    tick();
  }

    lockBanner();
    retargetNav();
    if (conference) paintConference();
    else if (document.querySelector(".navcards")) paintFloor();
})();
