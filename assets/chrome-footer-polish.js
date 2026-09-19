/* Overnight polish: normalize footers after chrome.js boot. */
(function(){
  "use strict";
  function apply(){
    var links = [
      ["/method/", "Method"], ["/method/#speed", "SPEED"],
      ["/panels/", "Panels"], ["/projects/", "Projects"],
      ["/privacy/", "Privacy"], ["/terms/", "Terms"],
      ["/governor/", "Governor"], ["/intake/", "Intake"], ["/xray/", "X-ray"],
      ["mailto:abdus@sfdc24.com", "abdus@sfdc24.com"]
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
      a.href = links[j][0]; a.textContent = links[j][1];
      nav.appendChild(a);
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function(){ setTimeout(apply, 0); });
  else setTimeout(apply, 0);
})();
