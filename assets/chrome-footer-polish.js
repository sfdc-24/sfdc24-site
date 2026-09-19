/* Overnight polish: normalize footers after chrome.js boot.
   Homepage keeps in-place cabinet links (data-cabinet-link); other pages keep deep links. */
(function(){
  "use strict";
  function pathNorm() {
    return (location.pathname || "/").replace(/\/+$/, "") || "/";
  }
  function isHome() {
    var p = pathNorm();
    return p === "/" || p === "/index.html";
  }
  function apply(){
    var home = isHome();
    var links = home ? [
      ["#", "Board", "board"],
      ["#cabinet-method", "Method", "method"],
      ["#cabinet-method", "SPEED", "method"],
      ["#cabinet-panels", "Panels", "panels"],
      ["/projects/", "Projects", ""],
      ["/history/", "History", ""],
      ["#cabinet-privacy", "Privacy", "privacy"],
      ["#cabinet-terms", "Terms", "terms"],
      ["/governor/", "Governor", ""],
      ["/intake/", "Intake", ""],
      ["/xray/", "X-ray", ""],
      ["mailto:abdus@sfdc24.com", "abdus@sfdc24.com", ""]
    ] : [
      ["/method/", "Method", ""],
      ["/method/#speed", "SPEED", ""],
      ["/panels/", "Panels", ""],
      ["/projects/", "Projects", ""],
      ["/history/", "History", ""],
      ["/privacy/", "Privacy", ""],
      ["/terms/", "Terms", ""],
      ["/governor/", "Governor", ""],
      ["/intake/", "Intake", ""],
      ["/xray/", "X-ray", ""],
      ["mailto:abdus@sfdc24.com", "abdus@sfdc24.com", ""]
    ];
    var foot = document.querySelector("footer");
    if (!foot) {
      foot = document.createElement("footer");
      foot.className = "chrome-foot";
      document.body.appendChild(foot);
    } else if (String(foot.className).indexOf("chrome-foot") < 0) {
      foot.className += " chrome-foot";
    }
    if (foot.classList && foot.classList.contains("method")) return;
    var tag = foot.querySelector("[data-chrome-tagline]");
    if (!tag) {
      var kids = foot.children;
      for (var t = 0; t < kids.length; t++) {
        if (kids[t].tagName === "DIV" || kids[t].tagName === "SPAN") { tag = kids[t]; break; }
      }
      if (!tag) { tag = document.createElement("div"); foot.insertBefore(tag, foot.firstChild); }
      tag.setAttribute("data-chrome-tagline", "1");
    }
    tag.textContent = "Interactive build, integration and AI enablement";
    var nav = foot.querySelector("nav");
    if (!nav) {
      nav = document.createElement("nav");
      foot.appendChild(nav);
      var promote = [];
      for (var p = 0; p < foot.children.length; p++) {
        if (foot.children[p].tagName === "A") promote.push(foot.children[p]);
      }
      for (var q = 0; q < promote.length; q++) nav.appendChild(promote[q]);
    }
    while (nav.firstChild) nav.removeChild(nav.firstChild);
    for (var j = 0; j < links.length; j++) {
      var a = document.createElement("a");
      a.href = links[j][0];
      a.textContent = links[j][1];
      if (links[j][2]) a.setAttribute("data-cabinet-link", links[j][2]);
      nav.appendChild(a);
    }
    if (home && !foot.__cabFootBound) {
      foot.__cabFootBound = true;
      foot.addEventListener("click", function (e) {
        var a = e.target && e.target.closest ? e.target.closest("[data-cabinet-link]") : null;
        if (!a || !foot.contains(a)) return;
        var name = a.getAttribute("data-cabinet-link");
        if (!name) return;
        e.preventDefault();
        try {
          if (window.__SFDC24_CABINET && typeof window.__SFDC24_CABINET.show === "function") {
            window.__SFDC24_CABINET.show(name);
            return;
          }
        } catch (err) {}
        try { location.hash = name === "board" ? "#" : "#cabinet-" + name; } catch (err2) {}
      });
    }
    try {
      if (home && window.__SFDC24_CABINET && typeof window.__SFDC24_CABINET.show === "function") {
        setTimeout(function () {
          try {
            var nodes = document.querySelectorAll("[data-cabinet-link]");
            for (var i = 0; i < nodes.length; i++) {
              if (nodes[i].__cabBound) continue;
              nodes[i].__cabBound = true;
              nodes[i].addEventListener("click", function (ev) {
                ev.preventDefault();
                var n = this.getAttribute("data-cabinet-link");
                if (n) window.__SFDC24_CABINET.show(n);
              });
            }
          } catch (e3) {}
        }, 0);
      }
    } catch (e4) {}
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function(){ setTimeout(apply, 0); });
  else setTimeout(apply, 0);
})();
