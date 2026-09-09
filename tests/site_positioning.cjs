// What the site is allowed to claim, and who it is allowed to sell.
//
// WHY THIS EXISTS
//   On 2026-09-08 at 18:51Z a commit titled "lead with capability" shipped the
//   opposite: an H1 reading "I make heavy Salesforce orgs light again", a deck
//   listing personal certifications, a "Who you're actually dealing with"
//   section, and structured data telling Google the business was a named
//   individual with fourteen years of experience.
//
//   Mr. Salam had asked, at almost exactly that time, not to be personified —
//   the offer is a capability, not a person. That instruction was applied to an
//   unpublished draft and never to the live page. It stayed up for eleven hours
//   while hourly status reports went out, and it was he who noticed, not us.
//
//   A rule did not prevent that, because a rule has to be remembered by whoever
//   edits the page next. This file is the mechanism: the claim is now checked
//   on every change to the site's copy, and a page that sells a person fails
//   the build.
//
//   He remains reachable. "Site contact by email" is exactly what he asked for
//   and is explicitly allowed below — what is not allowed is selling him.
//
// WHAT THREE ROUNDS OF REVIEW ADDED, each because this file passed while the
// site was still wrong:
//
//   1. The first-person list held only I / I' / my, and walked past "don't hire
//      me" and "isn't mine to solve" sitting on the live homepage.
//   2. It checked three pages out of nine, and `if (!exists) continue` meant a
//      renamed page silently dropped out of coverage rather than failing.
//   3. It stripped <script> before looking, so every visitor-facing string that
//      the page writes into the DOM at runtime — the voice greeting, the chat's
//      own words — was invisible to it.
//   4. It was entirely negative. Nothing asserted the site says what it is
//      supposed to say, so a page could pass by saying nothing at all — which
//      is exactly how half the visitors kept getting the superseded operations
//      proposition through the A/B while every test was green.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// The exact bytes `python assets/make_og.py` produces from the copy in that
// file. Pinned so the shipped card cannot drift from the checked words.
const OG_SHA256 = 'cfcc580b9088144e0b46aa5251ae8826e3b02c1224e653ec863daf8f7057d2ee';

const REPO = path.join(__dirname, '..');
const CONTACT_EMAIL = 'abdus@sfdc24.com';

// Every public HTML surface, discovered rather than listed, so a new page is
// covered the day it lands instead of the day someone remembers this file.
function discoverPages(dir = REPO, prefix = '') {
  const skip = new Set(['node_modules', '.git', '.github', 'tests', 'assets', 'docs']);
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || skip.has(entry.name)) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) found.push(...discoverPages(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith('.html')) found.push(rel);
  }
  return found.sort();
}

const PAGES = discoverPages();

// A floor, not the list. If one of these disappears the site lost a page and
// this file must fail rather than quietly cover less than it did yesterday.
const REQUIRED_PAGES = [
  '404.html', 'index.html', 'intake/index.html', 'privacy/index.html',
  'projects/index.html', 'terms/index.html', 'voice/index.html', 'xray/index.html',
];

// Phrases that sell a person rather than a capability. Each was on the live
// homepage; none is a hypothetical.
const SELLS_A_PERSON = [
  'Certified administrator since 2013',
  'Six Sigma Black Belt',
  'Fourteen years',
  'Principal Consultant',
  'I make heavy Salesforce orgs light again',
  "Who you're actually dealing with",
  'Certifications held',
  'Certified ScrumMaster',
  'independent Salesforce operations consultant',
];

// First-person singular sells a person by grammar alone, without naming one.
//
// NOTE THE DOUBLE BACKSLASHES. In a JavaScript string literal '\b' is a
// BACKSPACE character, not a word boundary, so new RegExp('\bI\s') builds
// /<0x08>Is/ and matches nothing. Two earlier versions of this line shipped
// exactly that and the suite went green with the guard switched off. It was
// caught only by dumping the file with `cat -A`. If you edit this, run
// `node tests/mutate_positioning.cjs` and watch each mutation FAIL first.
//
// FIRST PERSON PLURAL IS DELIBERATELY ALLOWED. "we", "us" and "our" are the
// capability speaking, which is the voice Mr. Salam asked for. Only the
// singular sells a person, so only the singular is banned here.
const FIRST_PERSON = [
  new RegExp('\\bI\\b'),
  new RegExp("\\bI'"),
  new RegExp('\\bmy\\b', 'i'),
  new RegExp('\\bmine\\b', 'i'),
  new RegExp('\\bme\\b', 'i'),
  new RegExp('\\bmyself\\b', 'i'),
];

// The exact copy this guard failed to catch. If any stops failing, the list has
// been narrowed back to where it was.
const KNOWN_SINGULAR_COPY = [
  'When is the honest answer "don\'t hire me"?',
  "If your problem isn't mine to solve, it will say so.",
  'I make heavy Salesforce orgs light again.',
  "Here's how I actually work.",
  'What I usually find.',
];

// TWO NARROW EXCEPTIONS, each an exact string, each for the same reason: a
// conversational interface speaking its own turn is not the business selling a
// person. "Tell me what's going on" is the microphone talking to you. Exact
// strings, so new person-selling copy cannot slip in behind the exemption.
const CONVERSATIONAL_VOICE = [
  'tell me what’s going on',
  'I’ll answer out loud',
  'what does my browser support?',
  // The assistant apologising for its own failure. Same class: the interface
  // speaking its turn, not the business putting a person forward.
  'I couldn’t reach the assistant just then',
];

// The proposition Mr. Salam asked the whole site to be about, 2026-09-08:
// "make sfdc24.com and all content about Salesforce assessment, business
// process automation and AI enablement for enterprises."
//
// TWO TIERS, because one loose alternation was not a contract. The first
// version matched any one of seven terms, so a page saying only "security"
// passed as on-proposition — which let variant A ship a hero that named no part
// of the offer. The primary surfaces now have to name the OFFER; the pillar
// names support it but cannot stand in for it.
const PROPOSITION_CORE = /assessment|business process automation|\bautomation\b|AI enablement/i;
const PROPOSITION_PILLARS = /security|operability|waste|redundancy/i;
const PROPOSITION = new RegExp(`${PROPOSITION_CORE.source}|${PROPOSITION_PILLARS.source}`, 'i');

// The retired proposition, in every form it has appeared in. Anything on a
// public surface — including the share image's source copy — that says one of
// these is still selling the thing that was replaced.
const RETIRED = [
  /operations,\s*Toronto/i,
  /Salesforce operations for orgs nobody wants to touch/i,
  /independent consulting/i,
  /independent Salesforce operations consultant/i,
];

function readPage(rel) {
  const file = path.join(REPO, rel);
  // Never `continue` on a missing file. A page that vanished is a coverage
  // hole, and a silent one is worse than a loud failure.
  assert.ok(fs.existsSync(file), `${rel} is missing — coverage silently shrank`);
  return fs.readFileSync(file, 'utf8');
}

/** Text a visitor reads in the markup. */
function visible(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * Text a visitor reads because a SCRIPT put it there. The voice page's greeting,
 * the chat's own words and every recovery message live only here, so a guard
 * that stops at `visible()` never sees the copy those surfaces actually show.
 *
 * THIS IS A TOKENIZER, NOT A REGEX, AND THAT IS THE WHOLE POINT.
 *
 * The first version matched /"([^"\\]{8,})"|'([^'\\]{8,})'/ over the script
 * text. The failure is QUOTE-PAIRING DRIFT, and it starts with a literal too
 * short to match:
 *
 *   jsonp({action:"say", vid:vid, q:text}, function(res){
 *
 * `"say"` is three characters, so it fails the {8,} minimum. The regex then
 * pairs the CLOSING quote of "say" with a much later opening quote and captures
 * 65 characters of CODE as prose. From there the pairing is off by one quote
 * for the rest of the block, and a real visitor-facing literal's opening quote
 * is consumed as somebody else's closing quote. On the real homepage that hid
 * two lines a visitor sees whenever the backend is slow:
 *
 *   "I could not reach the assistant just then. Your message was not lost."
 *   "outcome unknown — I will not send your question twice"
 *
 * So the guard passed on a page that was still speaking in the first person.
 * Found by chatgpt-codex-desktop-01a0839e, not by this file.
 *
 * (My first explanation of this blamed an apostrophe inside a double-quoted
 * string. That was wrong, and the control in the regression test below is what
 * caught it — the reconstruction did not reproduce the bug. The mechanism above
 * was then diagnosed against index.html at f4bed49 rather than guessed.)
 *
 * Walking the source tracks what a parser tracks: comments, escapes, and all
 * three quote characters, so pairing cannot drift and template literals are
 * covered too.
 */
function scriptProse(html) {
  const blocks = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  const out = [];

  for (const block of blocks) {
    const src = block.replace(/^<script\b[^>]*>/i, '').replace(/<\/script>$/i, '');
    let i = 0;
    while (i < src.length) {
      const c = src[i];

      // Comments first: a quote inside one is not a string.
      if (c === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i += 2;
        continue;
      }

      if (c === '"' || c === "'" || c === '`') {
        const quote = c;
        let value = '';
        i++;
        while (i < src.length && src[i] !== quote) {
          if (src[i] === '\\') { value += src[i + 1] ?? ''; i += 2; continue; }
          value += src[i];
          i++;
        }
        i++; // past the closing quote
        // Eight characters with a space in them: a sentence, not a selector.
        if (value.length >= 8 && value.includes(' ') && !value.includes('://')) out.push(value);
        continue;
      }
      i++;
    }
  }
  return out.join(' \u2022 ');
}

/**
 * EVERYTHING a visitor can read on a page: the markup, plus the strings the
 * page's own scripts put on screen.
 *
 * This is a named function rather than an inline expression for a reason the
 * mutation harness found. The check below used to call scriptProse() directly,
 * so it proved the extractor worked — while the guard itself had stopped using
 * it. The mutation "stop reading script copy" was NOT CAUGHT: seven tests
 * green, one surface unchecked. Asserting on this function means the test and
 * the guard read the page the same way, which was the whole claim.
 */
function readablePage(html) {
  return `${visible(html)} • ${scriptProse(html)}`;
}

function withoutExemptions(text) {
  let out = text;
  for (const allowed of CONVERSATIONAL_VOICE) out = out.split(allowed).join(' ');
  return out;
}

/**
 * THE check. One function, used by the per-page tests and by the negative
 * controls, so a control cannot pass by exercising a path the guard has stopped
 * taking.
 *
 * The first version of the script-copy control called scriptProse() directly.
 * It proved the extractor worked, while the guard had already stopped calling
 * it — so the mutation "stop reading script copy" ran green and the voice page
 * was unchecked. The control was testing a component; the claim was about the
 * pipeline. Everything now goes through here.
 *
 * @returns {string|null} the offending snippet, or null if the page is clean
 */
function firstPersonHitIn(html) {
  const text = withoutExemptions(readablePage(html));
  for (const rx of FIRST_PERSON) {
    const hit = text.match(new RegExp(rx.source + '[^.]{0,50}', rx.flags));
    if (hit) return hit[0].trim();
  }
  return null;
}

test('every required page still exists and is covered', () => {
  for (const page of REQUIRED_PAGES) {
    assert.ok(PAGES.includes(page), `${page} is no longer discovered — coverage shrank`);
  }
  assert.ok(PAGES.length >= REQUIRED_PAGES.length);
});

for (const page of PAGES) {
  const html = readPage(page);
  const readable = readablePage(html);

  test(`${page} sells a capability, not a person`, () => {
    for (const phrase of SELLS_A_PERSON) {
      assert.ok(
        !new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(readable),
        `"${phrase}" is on ${page}. The offer is a capability; the person is a contact, not the pitch.`,
      );
    }
  });

  test(`${page} speaks as a capability, not a first person`, () => {
    const hit = firstPersonHitIn(html);
    assert.equal(hit, null, `${page} uses first-person singular: "...${hit}"`);
  });

  test(`${page} names him only as a contact address`, () => {
    // Every occurrence of his name must be part of the contact email. A bare
    // name in prose is the thing that went wrong.
    const total = (html.match(/abdus/gi) || []).length;
    const asEmail = (html.match(/abdus@sfdc24\.com/gi) || []).length;
    assert.equal(
      total - asEmail, 0,
      `${page} mentions him ${total - asEmail} time(s) outside the contact address.`,
    );
    assert.equal((html.match(/\bSalam\b/g) || []).length, 0, `${page} carries his surname in prose.`);
  });
}

// ── The positive contract ───────────────────────────────────────────────────
// Everything above is a prohibition, and a page can satisfy every prohibition
// by saying nothing. These say what the site MUST say.

test('the browser tab, the search snippet and the share card all carry the proposition', () => {
  // These are content. A visitor who never scrolls sees the title; a visitor on
  // LinkedIn sees only the card. Both were still selling "Salesforce
  // operations, Toronto" after the body copy had been rewritten.
  const html = readPage('index.html');
  const grab = (re, what) => {
    const m = html.match(re);
    assert.ok(m, `index.html has no ${what}`);
    return m[1];
  };
  const surfaces = {
    'title': grab(/<title>([^<]*)<\/title>/i, '<title>'),
    'meta description': grab(/<meta name="description" content="([^"]*)"/i, 'meta description'),
    'og:title': grab(/<meta property="og:title" content="([^"]*)"/i, 'og:title'),
    'og:description': grab(/<meta property="og:description" content="([^"]*)"/i, 'og:description'),
    'og:image:alt': grab(/<meta property="og:image:alt" content="([^"]*)"/i, 'og:image:alt'),
  };
  for (const [name, value] of Object.entries(surfaces)) {
    assert.match(value, PROPOSITION, `${name} does not carry the proposition: "${value}"`);
    assert.doesNotMatch(value, /operations,\s*Toronto/i,
      `${name} still carries the superseded operations proposition`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'site.webmanifest'), 'utf8'));
  assert.match(manifest.description, PROPOSITION, 'the installed-app description still sells the old thing');
});

test('every public page says what this business does', () => {
  // Site-wide, not just the homepage. Intake, Projects and Privacy each carried
  // no proposition at all — they were generic, so a visitor landing on one from
  // search could not tell what is sold here. A prohibition-only guard passed
  // them, because saying nothing breaks no prohibition.
  for (const page of PAGES) {
    if (page === '404.html' || page.startsWith('governor/') || page.startsWith('xray/')) continue;
    const text = visible(readPage(page));
    assert.match(text, PROPOSITION_CORE, `${page} never names the offer`);
    for (const retired of RETIRED) {
      assert.doesNotMatch(text, retired, `${page} still carries the retired proposition: ${retired}`);
    }
  }
});

test('the share image itself is on-proposition, and can be checked', () => {
  // og.png was the LAST surface still reading "Salesforce operations for orgs
  // nobody wants to touch" / "Independent consulting - Toronto", after the body,
  // title, metadata and manifest were all fixed. It survived because a PNG is
  // opaque to every text guard here — and it is the surface a visitor sees
  // first, since a shared link renders as the image, not the page.
  //
  // The card is now generated from assets/make_og.py, so the copy is a string a
  // test can read. This asserts the source; the image is a build artifact of it.
  const gen = path.join(REPO, 'assets/make_og.py');
  assert.ok(fs.existsSync(gen), 'the share image must be generated from checkable copy, not hand-made');
  const src = fs.readFileSync(gen, 'utf8');

  const headline = src.match(/HEADLINE = \[([\s\S]*?)\]/);
  assert.ok(headline, 'make_og.py must define HEADLINE');
  const copy = [...headline[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]).join(' ');
  assert.match(copy, PROPOSITION_CORE, `the share image headline names no part of the offer: "${copy}"`);

  const subline = src.match(/SUBLINE = "([^"]*)"/);
  assert.ok(subline, 'make_og.py must define SUBLINE');
  for (const retired of RETIRED) {
    assert.doesNotMatch(`${copy} ${subline[1]}`, retired,
      `the share image still carries the retired proposition: ${retired}`);
  }

  // And the PNG must be the one this generator produces — bound by DIGEST.
  //
  // The first version of this check asserted the file exists and that its mtime
  // was greater than zero, which is true of every file that has ever existed. It
  // "claimed rebuild" and verified nothing: the copy above could be corrected
  // while the shipped image stayed exactly as it was, and this would pass. The
  // generator is byte-reproducible (verified by regenerating and comparing, and
  // independently by chatgpt-codex-desktop-01a0839e computing the same digest),
  // so the digest is a real binding.
  //
  // If you change the card, run `python assets/make_og.py` and update this.
  const png = path.join(REPO, 'assets/og.png');
  assert.ok(fs.existsSync(png), 'assets/og.png is missing');
  const digest = crypto.createHash('sha256').update(fs.readFileSync(png)).digest('hex');
  assert.equal(
    digest, OG_SHA256,
    'assets/og.png is not the image assets/make_og.py produces. Either the copy '
    + 'was changed without regenerating — so the corrected words are not in the '
    + 'shipped card — or the card was edited by hand and is no longer auditable. '
    + 'Run: python assets/make_og.py',
  );
});

test('the homepage still explains how the site is built, and by what method', () => {
  // Mr. Salam asked for the site to "share how the site is built by AI agents".
  // The copy exists and nothing asserted it, so it could be trimmed in an edit
  // and every test would stay green — the same hole that let variant A ship the
  // retired proposition. Four claims, each checked, because together they are
  // the argument rather than a boast about using AI.
  const text = visible(readPage('index.html'));
  const required = [
    [/shared board/i, 'the agents work on a shared board'],
    [/human making every consequential decision|human [a-z ]*decision/i, 'a human makes the consequential decisions'],
    [/review each other[\s\S]{0,40}reject|reject each other/i, 'the agents reject each other\'s work'],
    [/exact commit/i, 'review happens at an exact commit'],
    [/reproduce a claim/i, 'a reviewer reproduces a claim rather than accepting it'],
  ];
  for (const [rx, what] of required) {
    assert.match(text, rx, `the homepage no longer says ${what} — that is the method, not decoration`);
  }
});

test('BOTH A/B variants lead with the same proposition', () => {
  // The experiment was running the superseded operations pitch against the new
  // assessment one, so half of visitors were served the copy the rewrite was
  // meant to replace — and every test passed, because nothing looked at
  // variant A at all. An A/B may test phrasing. It may not keep shipping a
  // proposition that has been retired.
  const html = readPage('index.html');
  // The whole hero block, H1 and deck together — a headline may lead with the
  // problem as long as the block names the offer. Variant A named neither AI
  // enablement nor the research boundary while passing a one-loose-term check.
  const heroes = [...html.matchAll(/<div class="(vA|vB)">([\s\S]*?)<\/div>/g)];
  assert.equal(heroes.length, 2, 'expected exactly two hero variants');
  for (const [, variant, block] of heroes) {
    const text = visible(block);
    assert.match(text, /<h1>|Salesforce|Security/i, `variant ${variant} hero is empty`);
    assert.match(text, PROPOSITION_CORE, `variant ${variant} hero names no part of the offer: "${text.trim()}"`);
    assert.match(text, /AI enablement/i, `variant ${variant} hero omits AI enablement`);
    assert.match(text, /research stage/i,
      `variant ${variant} hero omits the research-stage boundary — the other variant states it, `
      + 'so half the visitors would get the claim without the caveat');
    for (const retired of RETIRED) {
      assert.doesNotMatch(text, retired, `variant ${variant} still sells the retired proposition`);
    }
  }
});

// ── The honesty property, and why it is pinned rather than pattern-matched ───
//
// Flip this ONLY when a collector genuinely reads a customer org, in the same
// change that makes it true. It is a constant and not a content sniff for a
// reason: the previous version of the guard below read
//
//     if (!/synthetic/i.test(xray)) return;   // this guard retires itself
//
// which let the thing being guarded switch the guard off. That is the same
// shape chatgpt-codex-desktop-01a0839e found in the MCP plan on the same day —
// a safety property that can be disabled by editing the document it protects.
const COLLECTOR_READS_REAL_ORGS = false;

// The sentences that make the page honest. PINNED, because enumerating every
// phrasing of a false claim is a losing game and this was proved rather than
// assumed: with /xray/ untouched, changing the homepage to "We assess your
// production Salesforce org against four pillars today" passed BOTH suites,
// 42/42 and OK, because the old check was one narrow regex for "scores a live
// org".
//
// Deleting a known sentence is detectable in a way that inventing a new claim
// is not. To claim live scanning, someone now has to remove a denial, and that
// fails here.
const HONESTY_DENIALS = [
  "Nothing here has scored anyone's Salesforce instance.",
  'What does not exist yet is the part that reads a live org.',
  'The connector is designed and not built.',
];

test('the collector flag is off until a collector exists', () => {
  // Without this, flipping one boolean disarms all three honesty guards in a
  // single character and every one of them reports green. A kill switch nothing
  // watches is not better than the self-retiring check it replaced — it is the
  // same failure with a nicer name.
  //
  // When a collector genuinely reads a customer org: flip the constant, delete
  // this test, and say in the commit message which org was read and when. All
  // three should be one change, reviewed together.
  assert.equal(
    COLLECTOR_READS_REAL_ORGS, false,
    'COLLECTOR_READS_REAL_ORGS was set true. That silently disables every check '
    + 'that stops this site claiming it reads customer Salesforce orgs. If a '
    + 'collector really shipped, remove this test in the same change and name the '
    + 'org it read.',
  );
});

test('the homepage still denies, in so many words, that it reads a live org', () => {
  if (COLLECTOR_READS_REAL_ORGS) return;
  const text = visible(readPage('index.html'));
  for (const denial of HONESTY_DENIALS) {
    assert.ok(
      text.includes(denial),
      `the homepage no longer says "${denial}"\n`
      + 'That sentence is what makes the surrounding claims honest. If a collector '
      + 'genuinely shipped, set COLLECTOR_READS_REAL_ORGS = true in the same change '
      + 'that makes it true — do not delete the denial and leave the constant alone.',
    );
  }
});

test('/xray/ still declares its data synthetic, and this suite checks it too', () => {
  // tests/test_xray_page.py also guards this. That is not a reason to skip it
  // here: the two suites run from different workflows with different path
  // filters, and the check below used to DEPEND on this being true while doing
  // nothing to ensure it. A guard that relies on another guard, across a
  // workflow boundary, is relying on something it cannot see.
  if (COLLECTOR_READS_REAL_ORGS) return;
  const xray = readPage('xray/index.html');
  assert.match(xray, /synthetic sample data/i, '/xray/ no longer calls its data synthetic sample data');
  assert.match(xray, /synthetic demo data/i, '/xray/ no longer calls its data synthetic demo data');
  assert.ok(
    (xray.match(/synthetic/gi) || []).length >= 4,
    'the homepage tells the reader /xray/ says so "in four places" — it no longer does',
  );
});

test('no page claims a live org is being scored', () => {
  // Runs unconditionally now. The homepage once said "the assessment model is
  // real and scores a live org", which was false, and the check that caught it
  // could be switched off by editing /xray/.
  if (COLLECTOR_READS_REAL_ORGS) return;
  const claims = [
    /scores? a live org/i,
    /assess(?:es)? your (?:production|live|real) [^.]{0,20}org/i,
    /scan(?:s|ning)? your (?:production|live|real) [^.]{0,20}org/i,
    /read(?:s|ing)? your (?:production|live|real) [^.]{0,20}org/i,
    /connected to your (?:salesforce|org)/i,
  ];
  for (const page of PAGES) {
    const text = visible(readPage(page));
    for (const claim of claims) {
      const hit = text.match(claim);
      assert.equal(
        hit, null,
        `${page} claims a real customer org is being read: "${hit && hit[0]}". `
        + 'Nothing reads a live org yet.',
      );
    }
  }
});

test('he is still reachable — this guard must not remove the contact', () => {
  const html = readPage('index.html');
  assert.ok(
    html.includes(`mailto:${CONTACT_EMAIL}`),
    'the homepage must still offer the contact email. Stripping the person is not the goal; '
    + 'selling the capability instead of the person is.',
  );
});

test('structured data describes the service, not an individual', () => {
  const html = readPage('index.html');
  const block = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/i);
  assert.ok(block, 'the homepage should carry structured data');

  const data = JSON.parse(block[1]);
  assert.equal(data['@type'], 'ProfessionalService', 'the entity Google indexes is the service');
  assert.equal(data.founder, undefined, 'no founder block — that is a person being sold');
  assert.equal(data.employee, undefined);
  assert.equal(data.hasCredential, undefined, 'credentials belong to a person, not a service');
  assert.doesNotMatch(
    String(data.description || ''), /certified|years|black belt/i,
    'the description Google reads must describe the work, not a CV',
  );
  assert.match(String(data.description || ''), PROPOSITION);
  assert.equal(data.email, CONTACT_EMAIL, 'contact address should survive');
});

// ── Negative controls ───────────────────────────────────────────────────────

test('the first-person list catches every line it has ever missed', () => {
  for (const copy of KNOWN_SINGULAR_COPY) {
    assert.ok(FIRST_PERSON.some((rx) => rx.test(copy)), `no FIRST_PERSON pattern catches: ${copy}`);
  }
});

test('the capability may still speak as "we" — plural is not the thing being banned', () => {
  for (const copy of [
    "You'll get a straight answer, or an honest \"that's not us\".",
    'What we find in the first week.',
    'Our assessment covers four pillars.',
  ]) {
    const fired = FIRST_PERSON.find((rx) => rx.test(copy));
    assert.equal(fired, undefined, `FIRST_PERSON ${fired} wrongly fires on plural voice: ${copy}`);
  }
});

test('a SHORT literal cannot desynchronise quote pairing and hide a later one', () => {
  // THE REGRESSION, from the real page rather than from a guess. The old
  // extractor was:
  //     /"([^"\\]{8,})"|'([^'\\]{8,})'/g
  //
  // My first account of this said an apostrophe inside a double-quoted string
  // opened a bogus single-quoted match. That was WRONG, and the control in the
  // first version of this test is what caught it: the reconstruction did not
  // reproduce the bug. Diagnosed against index.html at f4bed49, the mechanism
  // is quote-pairing drift:
  //
  //   jsonp({action:"say", vid:vid, q:text}, function(res){
  //
  // `"say"` is three characters, so it fails the {8,} minimum and does not
  // match. The regex then pairs the CLOSING quote of "say" with a much later
  // opening quote and captures 65 characters of CODE as if it were prose. From
  // there the pairing is off by one quote for the rest of the block, and the
  // real visitor-facing literal's opening quote is consumed as somebody else's
  // closing quote — so it is never extracted at all.
  //
  // That is why this needs a tokenizer and not a better regex: only something
  // that tracks which quotes are delimiters can stay in sync.
  const page = [
    '<html><body><script>',
    '    jsonp({action:"say", vid:vid, q:text}, function(res){',
    '      busy=false; state.textContent="";',
    '      if(!res || !res.ok){',
    '        showRecovery("I could not reach the assistant just then.", true);',
    '      }',
    '    });',
    '</script></body></html>',
  ].join('\n');

  const oldExtractor = (html) => {
    const blocks = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/gi) ?? [];
    const out = [];
    for (const b of blocks) {
      for (const m of b.matchAll(/"([^"\\]{8,})"|'([^'\\]{8,})'/g)) {
        const s = m[1] ?? m[2];
        if (s.includes(' ') && !s.includes('://')) out.push(s);
      }
    }
    return out.join(' \u2022 ');
  };

  // Control: the old way really does lose it. If this ever stops holding, the
  // fixture no longer reproduces the bug and everything below proves nothing.
  assert.doesNotMatch(
    oldExtractor(page), /could not reach the assistant/,
    'the fixture no longer reproduces the pairing drift — fix the fixture, not this assertion',
  );
  // And it really did read code as prose, which is the other half of the defect.
  assert.match(oldExtractor(page), /function\(res\)/,
    'the fixture no longer reproduces the regex capturing code as prose');

  // The guard as it stands sees the visitor-facing line, and fails on it.
  assert.match(scriptProse(page), /could not reach the assistant/,
    'the extractor is losing literals to quote-pairing drift again');
  assert.notEqual(firstPersonHitIn(page), null,
    'first-person copy after a short literal is invisible to the guard again');
});

test('the guard catches first-person copy that exists ONLY inside a script', () => {
  // A synthetic page whose only prose is a script string, run through the same
  // firstPersonHitIn() the per-page tests use. If the guard ever goes back to
  // stripping <script> before looking, this returns null and fails — which is
  // what the previous version of this control could not do, because it called
  // the extractor directly instead of the guard.
  const scriptOnly = '<html><body><script>ui.say("I have fourteen years of experience");</script></body></html>';
  assert.notEqual(firstPersonHitIn(scriptOnly), null,
    'copy the page writes into the DOM at runtime is invisible to this guard');

  // And the real surface it was written for.
  assert.match(readablePage(readPage('voice/index.html')), /microphone/i,
    'the greeting a visitor actually hears is not reaching the guard');
});

test('the exemption list is exact strings, not a pattern anything can match', () => {
  // A first-person sentence that is NOT one of the three allowed strings must
  // still fail, or the exemption is a hole rather than a carve-out.
  const smuggled = withoutExemptions('I have fourteen years of experience and my rate is fair.');
  assert.ok(FIRST_PERSON.some((rx) => rx.test(smuggled)),
    'the conversational-voice exemption let new first-person copy through');
});

test('the guard would actually catch the regression it was written for', () => {
  const regressed = '<h1>I make heavy Salesforce orgs light again.</h1>';
  const text = visible(regressed);
  const caught = SELLS_A_PERSON.some((p) =>
    new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text));
  assert.ok(caught, 'the phrase list no longer catches the copy that caused this file to exist');
});
