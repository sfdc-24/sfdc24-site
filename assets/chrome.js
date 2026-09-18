/* The shared page chrome: one script, every page, and all it does is the date.
 *
 * Asked for 2026-09-18 (GROK-SITE-VIBE-002c): the header carries a date instead
 * of the wordmark, "dynamically generated current date (visitor/local or
 * America/Toronto)", on every page.
 *
 * WHY IT IS NOT WRITTEN INTO THE HTML
 * This site is static and served from a CDN. A date typed into the markup is
 * correct until midnight and then wrong, indefinitely, while looking exactly as
 * confident as a correct one - on a site whose whole doctrine is that it must
 * not display anything untrue. So the markup carries a placeholder and this
 * writes over it from the reader's own clock.
 *
 * WHY IT DECLINES RATHER THAN GUESSING
 * If anything here throws, the placeholder stays. A header that quietly says
 * "Today" is a header that has not told anybody anything; a header showing the
 * wrong day has.
 *
 * The homepage does the same thing for its hero line in its own script. That is
 * duplication of four lines, and the alternative - the hero waiting on an
 * external file - costs a request on the one page that is measured for how fast
 * it paints.
 */
(function () {
  "use strict";

  var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MONTHS = ["January", "February", "March", "April", "May", "June",
                "July", "August", "September", "October", "November", "December"];

  function write() {
    var hosts = document.querySelectorAll ? document.querySelectorAll("[data-chrome-date]") : [];
    if (!hosts || !hosts.length) return;
    var now = new Date();
    var weekday = DAYS[now.getDay()];
    var day = String(now.getDate());
    var rest = " " + MONTHS[now.getMonth()] + " " + now.getFullYear();
    for (var i = 0; i < hosts.length; i++) {
      var el = hosts[i];
      /* Built as nodes rather than a string of HTML. Nothing here comes from a
         visitor, so this is not an injection fix - it is that a page which
         assembles markup from strings is one edit away from being one. */
      el.textContent = weekday + ", ";
      var b = document.createElement("b");
      b.textContent = day;
      el.appendChild(b);
      el.appendChild(document.createTextNode(rest));
    }
  }

  try {
    if (document.readyState === "loading" && document.addEventListener) {
      document.addEventListener("DOMContentLoaded", function () {
        try { write(); } catch (e) {}
      });
    } else {
      write();
    }
  } catch (e) {}
})();
