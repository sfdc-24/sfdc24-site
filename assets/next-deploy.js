/* This release label travels with the shipped site assets.
 * A browser timer cannot observe a deployment. Never manufacture a deadline,
 * or call a release early/on-time/delayed from elapsed visitor session time.
 * Actual build completion is verified against Pages and production by the
 * release owner. Update this description when shipping a visitor-facing change.
 */
(function () {
  'use strict';
  var DEFAULT_NOTE = "Readable header and current date";

  function place(el) {
    var header = document.querySelector('header.chrome-bar, header.masthead, header.bar, .chrome-bar');
    if (!header) return false;
    if (el.parentNode !== header) header.appendChild(el);
    return true;
  }

  function boot() {
    var path = (location.pathname || '/').replace(/\/+$/, '') || '/';
    if (path !== '/' && path !== '/index.html') return;
    if (document.getElementById('nextDeploy')) return;
    var style = document.createElement('style');
    style.id = 'nd-style';
    style.textContent =
      '#nextDeploy{margin-left:auto;max-width:100%;min-width:0;color:#FFFFFF;pointer-events:none}' +
      '#nextDeploy .nd-sum{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font:500 12px/1.5 system-ui,sans-serif}' +
      '#nextDeploy .nd-sum b{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:#FFFFFF}' +
      '#nextDeploy .s{color:#8FC7FF;overflow-wrap:anywhere}' +
      '@media(max-width:720px){#nextDeploy{flex-basis:100%;margin-left:0}}';
    document.head.appendChild(style);
    var root = document.createElement('aside');
    root.id = 'nextDeploy';
    root.setAttribute('aria-label', 'About this release');
    var summary = document.createElement('div');
    summary.className = 'nd-sum';
    var title = document.createElement('b');
    title.textContent = 'This release';
    var note = document.createElement('span');
    note.id = 'ndSentence';
    note.className = 's';
    note.textContent = DEFAULT_NOTE;
    summary.appendChild(title);
    summary.appendChild(note);
    root.appendChild(summary);
    if (!place(root)) document.body.appendChild(root);
    setTimeout(function () { place(root); }, 400);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
