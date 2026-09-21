/* Choice-design preference probe — Method only.
   Catalog: data/choice-design-pilot.json (status stays pilot-not-deployed).
   Seed-24 sets from tools/choice_design.py. Picks stay in memory.
   Does not set cookies, does not switch palette, ask bar, or Release rail. */
(function () {
  "use strict";

  var ACCENT = "#0A66C2";
  var SETS = [
    [
      { ask_bar_copy: "What are you working on?", palette: "cobalt", release_density: "countdown-plus-last-release" },
      { ask_bar_copy: "What are you working on?", palette: "trust-navy", release_density: "countdown-only" }
    ],
    [
      { ask_bar_copy: "What decision are you facing?", palette: "cobalt", release_density: "countdown-plus-last-release" },
      { ask_bar_copy: "What decision are you facing?", palette: "google-blue", release_density: "countdown-only" }
    ],
    [
      { ask_bar_copy: "What are you working on?", palette: "cobalt", release_density: "countdown-only" },
      { ask_bar_copy: "What are you working on?", palette: "google-blue", release_density: "countdown-plus-last-release" }
    ],
    [
      { ask_bar_copy: "What decision are you facing?", palette: "google-blue", release_density: "countdown-only" },
      { ask_bar_copy: "What are you working on?", palette: "trust-navy", release_density: "countdown-plus-last-release" }
    ],
    [
      { ask_bar_copy: "What decision are you facing?", palette: "trust-navy", release_density: "countdown-only" },
      { ask_bar_copy: "What are you working on?", palette: "cobalt", release_density: "countdown-only" }
    ],
    [
      { ask_bar_copy: "What decision are you facing?", palette: "cobalt", release_density: "countdown-only" },
      { ask_bar_copy: "What are you working on?", palette: "trust-navy", release_density: "countdown-plus-last-release" }
    ],
    [
      { ask_bar_copy: "What decision are you facing?", palette: "google-blue", release_density: "countdown-only" },
      { ask_bar_copy: "What are you working on?", palette: "google-blue", release_density: "countdown-plus-last-release" }
    ],
    [
      { ask_bar_copy: "What decision are you facing?", palette: "google-blue", release_density: "countdown-plus-last-release" },
      { ask_bar_copy: "What are you working on?", palette: "trust-navy", release_density: "countdown-plus-last-release" }
    ]
  ];

  var ATTRS = [
    { key: "ask_bar_copy", label: "Ask bar" },
    { key: "palette", label: "Palette" },
    { key: "release_density", label: "Release density" }
  ];

  var LEVELS = {
    cobalt: "Cobalt",
    "google-blue": "Google Blue",
    "trust-navy": "Trust Navy",
    "countdown-only": "Countdown only",
    "countdown-plus-last-release": "Countdown plus last release"
  };

  function esc(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function levelLabel(value) {
    return LEVELS[value] || value;
  }

  function differCount(a, b) {
    var n = 0;
    for (var i = 0; i < ATTRS.length; i++) {
      var k = ATTRS[i].key;
      if (a[k] !== b[k]) n++;
    }
    return n;
  }

  function validateSets(sets) {
    if (!sets || sets.length < 1) return ["no choice sets"];
    var errors = [];
    for (var i = 0; i < sets.length; i++) {
      var pair = sets[i];
      if (!pair || pair.length !== 2) {
        errors.push("set " + (i + 1) + " needs two profiles");
        continue;
      }
      if (differCount(pair[0], pair[1]) < 2) {
        errors.push("set " + (i + 1) + " must differ on two attributes");
      }
    }
    return errors;
  }

  function profileHtml(attrs, index) {
    var rows = ATTRS.map(function (attr) {
      return "<div class=\"cd-row\"><dt>" + esc(attr.label) + "</dt><dd>" +
        esc(levelLabel(attrs[attr.key])) + "</dd></div>";
    }).join("");
    return '<button type="button" class="cd-profile" data-profile="' + (index + 1) + '"' +
      ' aria-pressed="false">' +
      "<h3>Profile " + (index + 1) + "</h3>" +
      '<dl class="cd-dl">' + rows + "</dl>" +
      "<span class=\"cd-pick\">Pick this</span></button>";
  }

  function tallyRows(picks) {
    var counts = {};
    ATTRS.forEach(function (attr) {
      counts[attr.key] = {};
    });
    picks.forEach(function (pick) {
      ATTRS.forEach(function (attr) {
        var value = pick[attr.key];
        counts[attr.key][value] = (counts[attr.key][value] || 0) + 1;
      });
    });
    return ATTRS.map(function (attr) {
      var parts = Object.keys(counts[attr.key]).sort().map(function (value) {
        return "<tr><td>" + esc(attr.label) + "</td><td>" +
          esc(levelLabel(value)) + "</td><td class=\"yr\">" +
          counts[attr.key][value] + "</td></tr>";
      });
      return parts.join("");
    }).join("");
  }

  function bind(root) {
    var status = root.querySelector("[data-cd-status]");
    var stage = root.querySelector("[data-cd-stage]");
    var note = root.querySelector("[data-cd-note]");
    var index = 0;
    var picks = [];

    function paint() {
      if (index >= SETS.length) {
        if (status) {
          status.textContent = "Session tally · " + picks.length +
            " picks · not a fitted model · no winner call";
        }
        if (stage) {
          stage.innerHTML =
            '<div class="tablewrap"><table class="ledger" data-cd-tally="1">' +
            "<caption>This session only</caption><tbody>" +
            tallyRows(picks) +
            "</tbody></table></div>" +
            '<p><button type="button" class="cd-again" data-cd-again="1">Again</button></p>';
          var again = stage.querySelector("[data-cd-again]");
          if (again) {
            again.addEventListener("click", function () {
              index = 0;
              picks = [];
              paint();
            });
          }
        }
        return;
      }
      var pair = SETS[index];
      if (status) {
        status.textContent = "Set " + (index + 1) + " of " + SETS.length +
          " · pick one · stays on this page";
      }
      if (stage) {
        stage.innerHTML = '<div class="cd-set" role="group" aria-label="Choice set ' +
          (index + 1) + '">' + profileHtml(pair[0], 0) + profileHtml(pair[1], 1) + "</div>";
        var buttons = stage.querySelectorAll(".cd-profile");
        buttons.forEach(function (btn) {
          btn.addEventListener("click", function () {
            var which = Number(btn.getAttribute("data-profile")) - 1;
            if (which !== 0 && which !== 1) return;
            picks.push(pair[which]);
            buttons.forEach(function (other) { other.setAttribute("aria-pressed", "false"); });
            btn.setAttribute("aria-pressed", "true");
            index += 1;
            paint();
          });
        });
      }
    }

    if (note) {
      note.textContent = "Cobalt stays locked (" + ACCENT +
        "). Palette on a card is a catalog level, not a site switch. Ask bar and Release rail do not change. No cookies.";
    }
    paint();
    return {
      sets: SETS,
      accent: ACCENT,
      validateSets: validateSets
    };
  }

  function boot() {
    window.__choiceDesignProbe = {
      accent: ACCENT,
      sets: SETS,
      validateSets: validateSets,
      errors: validateSets(SETS)
    };
    var root = document.getElementById("choice-design-probe");
    if (!root) return;
    return bind(root);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
