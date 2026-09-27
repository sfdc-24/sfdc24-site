/* Reapply the canonical footer after shared chrome has booted. */
(function(){
  "use strict";
  function apply(){
    var render = window.__SFDC24_RENDER_FOOTER;
    if (typeof render === "function") render();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", function(){ setTimeout(apply, 0); });
  else setTimeout(apply, 0);
})();
