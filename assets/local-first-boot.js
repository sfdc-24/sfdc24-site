/* Overnight local-first boot. Loads polish + chrome accuracy + NEXT DEPLOY rail. */
(function () {
  "use strict";
  function add(src) {
    try {
      if (document.querySelector('script[src="' + src + '"]')) return;
      var s = document.createElement("script");
      s.src = src;
      s.defer = true;
      document.head.appendChild(s);
    } catch (e) {}
  }
  add("/assets/overnight-polish-boot.js");
  add("/assets/chrome-footer-polish.js");
  add("/assets/chrome.js");
  add("/assets/next-deploy.js");
  try {
    if (!document.querySelector('link[href="/assets/chrome.css"]')) {
      var l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = "/assets/chrome.css";
      document.head.appendChild(l);
    }
  } catch (e2) {}
})();
