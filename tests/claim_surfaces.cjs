// Every surface a claim can reach a customer through, and the sentences on them.
//
// WHY THIS EXISTS
// ---------------
// Round two on PR19 got two false greens past a suite that had just been
// rebuilt to stop exactly that:
//
//   1. "SFDC24 imports metadata from live customer Salesforce tenants today and
//      publishes diagnostic scores." — visible on the page, and the CLAIMS
//      blocklist had never been taught those verbs.
//   2. "SFDC24 scores a live org today and returns a grade." — put in the
//      <meta name="description">, where NOTHING looked. `body.innerText` does
//      not include metadata, so the DOM spec, the positioning pre-check and all
//      22 mutations passed on a page whose search result and link preview said
//      the thing the page itself denies.
//
// I reproduced both before writing this.
//
// TWO DIFFERENT HOLES, TWO DIFFERENT FIXES.
//
// The second is a SURFACE hole and it closes structurally: enumerate every
// place customer-facing prose can live and scan all of them. That is mechanical
// and can be complete. The enumeration is deny-by-default — a <meta> whose name
// is not on the known-technical list is treated as prose and scanned, so adding
// a new tag cannot create a blind spot by omission.
//
// The first is a PHRASING hole and it does NOT close by adding verbs. I said so
// on the previous round and then shipped a list anyway; a reviewer walked past
// it in one line. There is always another phrasing, and I have now lost that
// arms race three times in one day — twice here and once on the plan document.
//
// So phrasing is inverted: every sentence on any surface that MENTIONS AN ORG
// is a candidate claim, and every candidate must appear in the reviewed
// allowlist in tests/capabilities.json. Deny by default. New copy in the risk
// class fails until a person has read it against the declared capability state.
// The trigger is deliberately over-inclusive — it costs a review line, and
// over-inclusion is the safe direction.
'use strict';

// Nouns that put a sentence in the risk class. Over-inclusive on purpose.
const ORG_NOUN = /\b(salesforce|orgs?|tenants?|instances?|environments?)\b/i;

// <meta> names that carry no customer-facing prose. EVERYTHING ELSE IS SCANNED,
// so forgetting to list a new one fails closed rather than opening a hole.
const TECHNICAL_META = new Set([
  'charset', 'viewport', 'theme-color', 'robots', 'referrer',
  'apple-mobile-web-app-capable', 'apple-mobile-web-app-status-bar-style',
  'format-detection', 'color-scheme', 'generator', 'author',
  'og:type', 'og:url', 'og:site_name', 'og:image', 'og:image:width',
  'og:image:height', 'og:locale', 'twitter:card', 'twitter:site',
  'twitter:creator', 'twitter:image', 'msapplication-TileColor',
]);

/**
 * Collect every customer-facing prose surface from a live DOM.
 * Runs inside page.evaluate, so it must be self-contained.
 */
const COLLECT_SURFACES = (technical) => {
  const out = [];
  const push = (surface, text) => {
    if (text && String(text).trim()) out.push({ surface, text: String(text) });
  };

  push('title', document.title);

  // PER BLOCK ELEMENT, not one body.innerText blob. Concatenating the whole
  // body produced three "sentences" of several thousand characters each on the
  // dashboard page, and approving a 4,000-character blob is not reviewing a
  // claim — it is initialling a wall. Leaf-level blocks give the sentences the
  // author actually wrote.
  const BLOCKS = 'p,li,h1,h2,h3,h4,h5,h6,td,th,dd,dt,figcaption,blockquote,summary,caption,label,legend';
  for (const el of document.querySelectorAll(BLOCKS)) {
    // Leaf blocks only: a <li> containing <p> would otherwise be counted twice,
    // once whole and once in pieces, and the whole version is the blob again.
    if (el.querySelector(BLOCKS)) continue;
    if (!el.checkVisibility || !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    push('body', el.innerText);
  }

  for (const el of document.querySelectorAll('meta[content]')) {
    const key = el.getAttribute('name') || el.getAttribute('property') || '';
    if (!key || technical.includes(key)) continue;
    push(`meta[${key}]`, el.getAttribute('content'));
  }

  // Alt text and accessible names are read aloud and indexed; they are prose.
  for (const el of document.querySelectorAll('img[alt]')) push('img[alt]', el.getAttribute('alt'));
  for (const el of document.querySelectorAll('[aria-label]')) {
    push('aria-label', el.getAttribute('aria-label'));
  }
  // Structured data is JSON, not prose: parse it and take the string VALUES,
  // so a description field is reviewed as a sentence instead of the whole
  // document arriving as one 452-character "claim" nobody would really read.
  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    let parsed = null;
    try { parsed = JSON.parse(el.textContent); } catch { parsed = null; }
    if (parsed === null) {
      // Unparseable structured data still reaches crawlers. Scan it raw rather
      // than skip it — a parse failure must not become a blind spot.
      push('ld+json(unparsed)', el.textContent);
      continue;
    }
    const walk = (node) => {
      if (typeof node === 'string') push('ld+json', node);
      else if (Array.isArray(node)) node.forEach(walk);
      else if (node && typeof node === 'object') Object.values(node).forEach(walk);
    };
    walk(parsed);
  }
  return out;
};

/** Normalise so whitespace and typography cannot fork one sentence into two. */
function normalise(s) {
  return String(s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Sentences on a surface that mention an org, i.e. candidate capability claims. */
function candidateClaims(text) {
  return normalise(text)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s && ORG_NOUN.test(s));
}

module.exports = {
  ORG_NOUN,
  TECHNICAL_META,
  COLLECT_SURFACES,
  normalise,
  candidateClaims,
};
