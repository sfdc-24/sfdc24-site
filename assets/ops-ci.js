/* Public Actions read for /ops. No actor, token, or invented green. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else api.load(root.document, root);
})(typeof window === 'undefined' ? globalThis : window, function () {
  'use strict';
  const URL = 'https://api.github.com/repos/sfdc-24/sfdc24-site/actions/runs?per_page=8';
  const RUN_URL = /^https:\/\/github\.com\/sfdc-24\/sfdc24-site\/actions\/runs\/\d+$/;

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch];
    });
  }

  function safeLink(url) {
    return typeof url === 'string' && RUN_URL.test(url) ? url : '';
  }

  function runsFrom(payload) {
    const list = payload && Array.isArray(payload.workflow_runs) ? payload.workflow_runs : [];
    return list.slice(0, 8).map(function (row) {
      const name = typeof row.name === 'string' ? row.name.slice(0, 80) : 'check';
      const conclusion = typeof row.conclusion === 'string' ? row.conclusion.slice(0, 32) : '';
      const status = typeof row.status === 'string' ? row.status.slice(0, 32) : '';
      const updated = typeof row.updated_at === 'string' ? row.updated_at.slice(0, 32) : '';
      return {name: name, conclusion: conclusion, status: status, html_url: safeLink(row.html_url), updated_at: updated};
    });
  }

  function renderCi(payload) {
    const runs = runsFrom(payload);
    if (!runs.length) return '<li>No CI run recorded. A missing read is not a green check.</li>';
    return runs.map(function (row) {
      const verdict = row.conclusion || row.status || 'unknown';
      const label = row.html_url
        ? '<a href="' + esc(row.html_url) + '">' + esc(row.name) + '</a>'
        : esc(row.name);
      const when = row.updated_at ? ' <span>' + esc(row.updated_at) + '</span>' : '';
      return '<li><b>' + esc(verdict) + '</b> ' + label + when + '</li>';
    }).join('');
  }

  async function load(doc, win) {
    const host = doc.getElementById('ci-status-rows');
    if (!host || !win || !win.fetch) return;
    try {
      const res = await win.fetch(URL, {cache: 'no-store', credentials: 'omit'});
      if (!res.ok) throw Error('ci');
      const body = await res.text();
      if (body.length > 200000) throw Error('ci size');
      host.innerHTML = renderCi(JSON.parse(body));
    } catch (_) {
      host.innerHTML = '<li>CI status not loaded. A missing read is not a green check.</li>';
    }
  }

  return {URL: URL, esc: esc, safeLink: safeLink, runsFrom: runsFrom, renderCi: renderCi, load: load};
});
