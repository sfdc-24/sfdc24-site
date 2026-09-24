/* Overnight polish: slim footer after chrome.js boot. Links only — no tagline, no brand, no clock. */
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
    var links = [
      [home ? "#" : "/", "Board", ""],
      ["/studio/", "Studio", ""],
      ["/method/", "Method", ""],
      ["/history/", "History", ""],
      ["/privacy/", "Privacy", ""],
      ["/terms/", "Terms", ""],
      ["https://www.linkedin.com/in/salams", "LinkedIn", ""]
    ];
    var specialized = document.querySelector("footer.method");
    var foot = document.querySelector("footer.chrome-foot") || document.querySelector("footer:not(.method)");
    if (!foot) {
      foot = document.createElement("footer");
      foot.className = "chrome-foot";
      if (specialized && specialized.parentNode) specialized.parentNode.appendChild(foot);
      else document.body.appendChild(foot);
    } else if (String(foot.className).indexOf("chrome-foot") < 0) {
      foot.className += " chrome-foot";
    }
    var extras = foot.querySelectorAll("[data-chrome-tagline], .chrome-mark, [data-live-brand], .chrome-date, .bardate, .deskline");
    for (var x = 0; x < extras.length; x++) {
      if (extras[x].parentNode) extras[x].parentNode.removeChild(extras[x]);
    }
    var leftovers = Array.prototype.slice.call(foot.children);
    for (var t = 0; t < leftovers.length; t++) {
      var kid = leftovers[t];
      if (kid.tagName === "NAV") continue;
      var txt = (kid.textContent || "").replace(/\s+/g, " ").trim();
      if (!txt || /interactive build/i.test(txt) || /^SFDC/.test(txt) || /Started/i.test(txt)) {
        if (kid.parentNode) kid.parentNode.removeChild(kid);
      }
    }
    var nav = foot.querySelector("nav");
    if (!nav) {
      nav = document.createElement("nav");
      foot.appendChild(nav);
    }
    while (nav.firstChild) nav.removeChild(nav.firstChild);
    for (var j = 0; j < links.length; j++) {
      var a = document.createElement("a");
      a.href = links[j][0];
      a.textContent = links[j][1];
      if (/^https?:/i.test(links[j][0])) {
        a.target = "_blank";
        a.rel = "noopener noreferrer";
      }
      nav.appendChild(a);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function(){ setTimeout(apply, 0); });
  else setTimeout(apply, 0);
})();
