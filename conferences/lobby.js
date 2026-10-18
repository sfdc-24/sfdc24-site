/* Sample lobby clock on /conferences/. Counts up only while the card
   is on screen and motion is allowed. No microphone, no socket, no fetch. */
(function () {
  var card = document.getElementById("conference-lobby");
  if (!card) return;
  var clock = card.querySelector(".lobby-clock");
  var tips = card.querySelectorAll(".lobby-tip");
  var reduce = false;
  var seen = false;
  var timer = 0;
  var seconds = 0;
  var tipIndex = 0;
  var TIP_EVERY = 5;
  var mq = null;

  try {
    mq = matchMedia("(prefers-reduced-motion: reduce)");
    reduce = !!mq.matches;
  } catch (err) {}

  function pad(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function paintClock() {
    if (!clock) return;
    var whole = seconds;
    clock.textContent = Math.floor(whole / 60) + ":" + pad(whole % 60);
  }

  function paintTips() {
    for (var i = 0; i < tips.length; i++) {
      var on = reduce || i === tipIndex;
      tips[i].classList.toggle("is-on", on);
      if (on) tips[i].removeAttribute("aria-hidden");
      else tips[i].setAttribute("aria-hidden", "true");
    }
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = 0;
  }

  function start() {
    if (timer || reduce) return;
    timer = setInterval(function () {
      if (seconds < 3599) seconds += 1;
      paintClock();
      var next = Math.floor(seconds / TIP_EVERY) % tips.length;
      if (next !== tipIndex) {
        tipIndex = next;
        paintTips();
      }
    }, 1000);
  }

  function sync() {
    var live = !reduce && seen && !document.hidden;
    if (!live) stop();
    card.classList.toggle("is-live", live);
    paintTips();
    if (live) start();
  }

  if (mq) {
    var onq = function () {
      reduce = !!mq.matches;
      if (reduce) stop();
      sync();
    };
    if (mq.addEventListener) mq.addEventListener("change", onq);
    else if (mq.addListener) mq.addListener(onq);
  }

  document.addEventListener("visibilitychange", sync);
  paintClock();
  sync();

  if (typeof IntersectionObserver !== "function") return;
  card.classList.add("is-armed");
  new IntersectionObserver(function (entries) {
    var entry = entries[entries.length - 1];
    seen = !!(entry && entry.isIntersecting && entry.intersectionRatio >= 0.35);
    sync();
  }, { threshold: [0, 0.35] }).observe(card);
})();
