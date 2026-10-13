/* Reading time, and Mermaid when a post includes a diagram. */
(function () {
  "use strict";

  var article = document.querySelector("[data-blog-article]");
  var slot = document.querySelector("[data-reading-time]");
  if (article && slot) {
    var text = (article.innerText || "").replace(/\s+/g, " ").trim();
    var count = text ? text.split(" ").length : 0;
    var minutes = Math.max(1, Math.round(count / 200));
    slot.textContent = minutes + " min read";
  }

  var blocks = document.querySelectorAll(".mermaid");
  if (!blocks.length || !window.mermaid) return;
  window.mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: {
      primaryColor: "#F3F2EF",
      primaryTextColor: "#191919",
      primaryBorderColor: "#191919",
      lineColor: "#0A66C2",
      fontFamily: "Public Sans, sans-serif"
    }
  });
  window.mermaid.run({ nodes: blocks });
})();
