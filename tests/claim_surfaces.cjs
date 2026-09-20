// Every surface a claim can reach a customer through, and the sentences on them.
//
// WHY THIS EXISTS
// ---------------
// Round two on PR19 got two false greens past a suite that had just been
// rebuilt to stop exactly that: a visible claim in verbs the blocklist had never
// learned, and a claim in <meta name="description"> where nothing looked.
//
// Round three got two more past the fix, and the finding was sharper than the
// bug: THIS FILE CLAIMED COMPLETENESS WHILE HAND-SELECTING CONTAINERS. The old
// collector walked `p,li,h1..h6,td,th,...` — an allowlist of tag names dressed
// up as a survey. A standalone <div> was invisible to it, and so was a <meta>
// carrying only `itemprop`, because the key was read from `name` or `property`
// and nothing else. I had written "unknown meta names are treated as prose, so
// omission fails closed" in this very file and then hand-listed the blocks
// three lines below it.
//
// So nothing is selected by tag name any more.
//
//   TEXT is collected by COMPUTED DISPLAY: every visible element that renders
//   as a block and contains no other visible block is a leaf, and its innerText
//   is one surface. `div`, `section`, `article` and anything else with block
//   display are included because of what they DO, not because they were listed.
//
//   COVERAGE IS PROVEN, not assumed. After collecting, a TreeWalker visits every
//   visible text node and checks it was covered by something. Anything missed —
//   a bare inline in <body>, a shadow of some layout I did not anticipate — is
//   emitted on its own rather than dropped. `verifyCoverage` reports it, and a
//   test asserts it is empty.
//
//   ATTRIBUTES are enumerated MECHANICALLY: every attribute of every element,
//   not a list of the ones I remembered. `title`, `placeholder`,
//   `aria-description`, `itemprop`+`content`, an SVG <text>, a `value` on a
//   button — all arrive without being named. Noise is filtered later by the org
//   trigger, not here, because filtering here is how the last two holes were
//   made.
'use strict';

// Nouns that put a sentence in the risk class. Over-inclusive on purpose.
const ORG_NOUN = /\b(salesforce|orgs?|tenants?|instances?|environments?)\b/i;

// Attribute values that are never prose read by a person. This list only
// affects NOISE, never coverage: anything omitted here is still collected and
// still checked, it just has to be reviewed once if it mentions an org.
const NON_PROSE_ATTRS = new Set([
  'href', 'src', 'srcset', 'class', 'id', 'style', 'type', 'rel', 'charset',
  'width', 'height', 'viewbox', 'd', 'fill', 'stroke', 'transform', 'points',
  'integrity', 'crossorigin', 'sizes', 'media', 'loading', 'decoding',
]);

/**
 * Collect every customer-facing prose surface from a live DOM.
 * Runs inside page.evaluate, so it must be entirely self-contained.
 */
const COLLECT_SURFACES = (nonProseAttrs) => {
  const skip = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT']);
  const out = [];
  const push = (surface, text) => {
    if (text && String(text).trim()) out.push({ surface, text: String(text) });
  };
  const visible = (el) => {
    try {
      return el.checkVisibility
        ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
        : true;
    } catch { return true; }
  };
  const blockish = (el) => {
    let d = '';
    try { d = getComputedStyle(el).display; } catch { d = ''; }
    return d === 'block' || d === 'flex' || d === 'grid' || d === 'list-item'
      || d === 'flow-root' || d === 'table' || d === 'table-cell'
      || d === 'table-caption' || d === 'table-row';
  };

  push('title', document.title);

  // ── Text, by computed display rather than by tag name ──────────────────
  const covered = new Set();
  const all = document.body ? Array.from(document.body.querySelectorAll('*')) : [];
  for (const el of all) {
    if (skip.has(el.tagName)) continue;
    if (!blockish(el) || !visible(el)) continue;
    if (Array.from(el.children).some((c) => blockish(c) && visible(c) && !skip.has(c.tagName))) {
      continue; // not a leaf block
    }
    const text = el.innerText;
    if (!text || !text.trim()) continue;
    push('body', text);
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let n; while ((n = walk.nextNode())) covered.add(n);
  }

  // Text sitting DIRECTLY inside a container that also holds blocks belongs to
  // no leaf, and on 404.html two such nodes ("sfdc24", the copyright line) were
  // reached only by the safety net below. Collect each element's own direct
  // text children as their own surface, so completeness holds by construction
  // rather than by a fallback catching what the rule missed.
  for (const el of all) {
    if (skip.has(el.tagName) || !visible(el)) continue;
    const own = Array.from(el.childNodes)
      .filter((c) => c.nodeType === 3 && c.nodeValue && c.nodeValue.trim());
    if (!own.length) continue;
    if (own.every((c) => covered.has(c))) continue;
    push('body', own.map((c) => c.nodeValue).join(' '));
    own.forEach((c) => covered.add(c));
  }

  // ── Prove the collection covered every visible text node ───────────────
  const missed = [];
  const walker = document.createTreeWalker(document.body || document, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue || !node.nodeValue.trim()) continue;
    const parent = node.parentElement;
    if (!parent || skip.has(parent.tagName) || !visible(parent)) continue;
    if (covered.has(node)) continue;
    missed.push(node.nodeValue);
    push('body(uncovered)', node.nodeValue);
  }

  // ── Attributes, enumerated rather than remembered ───────────────────────
  const everything = Array.from(document.querySelectorAll('*'));
  for (const el of everything) {
    if (skip.has(el.tagName) && el.tagName !== 'SCRIPT') continue;
    for (const attr of Array.from(el.attributes || [])) {
      const name = attr.name.toLowerCase();
      if (nonProseAttrs.includes(name)) continue;
      if (!attr.value || !attr.value.trim()) continue;
      const key = el.tagName === 'META'
        ? `meta[${el.getAttribute('name') || el.getAttribute('property')
            || el.getAttribute('itemprop') || el.getAttribute('http-equiv') || name}]`
        : `@${name}`;
      if (name === 'content' || !['name', 'property', 'itemprop', 'http-equiv'].includes(name)) {
        push(key, attr.value);
      }
    }
  }

  // ── Structured data: parsed to its string values ────────────────────────
  for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
    let parsed = null;
    try { parsed = JSON.parse(el.textContent); } catch { parsed = null; }
    if (parsed === null) {
      push('ld+json(unparsed)', el.textContent);
      continue;
    }
    const walkJson = (v) => {
      if (typeof v === 'string') push('ld+json', v);
      else if (Array.isArray(v)) v.forEach(walkJson);
      else if (v && typeof v === 'object') Object.values(v).forEach(walkJson);
    };
    walkJson(parsed);
  }

  return { surfaces: out, uncovered: missed };
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
  NON_PROSE_ATTRS,
  COLLECT_SURFACES,
  normalise,
  candidateClaims,
};
