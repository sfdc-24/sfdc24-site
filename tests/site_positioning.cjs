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

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const PAGES = ['index.html', 'intake/index.html', 'voice/index.html'];

const CONTACT_EMAIL = 'abdus@sfdc24.com';

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
];

// First-person singular sells a person by grammar alone, without naming one.
// "What I usually find" and "how I actually work" both survived the first pass
// of this rewrite because the name had gone and the voice had not.
// Built from source strings deliberately. An earlier version of this line
// was written through a shell heredoc, which turned every word-boundary
// escape into a literal backspace byte (0x08) - so the regexes read
// /<BS>I\s/ and could never match anything. The suite went green and the
// guard was inert. It was caught only by dumping the file with `cat -A`.
// The negative control had passed for a different reason, via the phrase
// list above, and I read that as proof the guard worked.
// NOTE THE DOUBLE BACKSLASHES. In a JavaScript string literal '\b' is a
// BACKSPACE character, not a word boundary, so new RegExp('\bI\s') builds
// /<0x08>Is/ and matches nothing. Two earlier versions of this line shipped
// exactly that and the suite went green with the guard switched off. If you
// edit this, run the mutation control below and watch it FAIL first.
//
// THIRD MISS, caught in review by copilot-pull-request-reviewer on this very PR:
// the list held I / I' / my and nothing else, so it walked straight past two
// sentences that were still live on the page this PR was written to fix —
// a chip reading `don't hire me` and a line reading `isn't mine to solve`.
// The suite was green while the page it guards still sold a person. Same shape
// as the backspace-byte failure above: the wiring was sound, the coverage was
// not, and green meant nothing.
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

// The exact copy this guard failed to catch. If any of these stops failing, the
// list has been narrowed back to where it was.
const KNOWN_SINGULAR_COPY = [
  'When is the honest answer "don\'t hire me"?',
  "If your problem isn't mine to solve, it will say so.",
  'I make heavy Salesforce orgs light again.',
  "Here's how I actually work.",
  'What I usually find.',
];

function visible(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');
}

for (const page of PAGES) {
  const file = path.join(REPO, page);
  if (!fs.existsSync(file)) continue;
  const html = fs.readFileSync(file, 'utf8');

  test(`${page} sells a capability, not a person`, () => {
    const text = visible(html);
    for (const phrase of SELLS_A_PERSON) {
      assert.ok(
        !new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text),
        `"${phrase}" is on ${page}. The offer is a capability; the person is a contact, not the pitch.`,
      );
    }
  });

  test(`${page} speaks as a capability, not a first person`, () => {
    const text = visible(html);
    for (const rx of FIRST_PERSON) {
      const hit = text.match(new RegExp(rx.source + '[^.]{0,50}', rx.flags));
      assert.equal(hit, null, `${page} uses first-person singular: "...${hit ? hit[0].trim() : ''}"`);
    }
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

test('he is still reachable — this guard must not remove the contact', () => {
  const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
  assert.ok(
    html.includes(`mailto:${CONTACT_EMAIL}`),
    'the homepage must still offer the contact email. Stripping the person is not the goal; '
    + 'selling the capability instead of the person is.',
  );
});

test('structured data describes the service, not an individual', () => {
  const html = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');
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
  assert.equal(data.email, CONTACT_EMAIL, 'contact address should survive');
});

test('the first-person list catches every line it has ever missed', () => {
  // Negative control. Each of these was real copy that shipped or survived a
  // green run of this file. If one stops being caught, the list has regressed.
  for (const copy of KNOWN_SINGULAR_COPY) {
    const caught = FIRST_PERSON.some((rx) => rx.test(copy));
    assert.ok(caught, `no FIRST_PERSON pattern catches: ${copy}`);
  }
});

test('the capability may still speak as "we" — plural is not the thing being banned', () => {
  // The guard must not fire on the voice the site is supposed to use. This is
  // as important as the assertion above: a guard that bans "us" would force the
  // copy back towards a named individual, which is the failure it exists to stop.
  for (const copy of [
    "You'll get a straight answer, or an honest \"that's not us\".",
    'What we find in the first week.',
    'Our assessment covers four pillars.',
  ]) {
    const fired = FIRST_PERSON.find((rx) => rx.test(copy));
    assert.equal(fired, undefined, `FIRST_PERSON ${fired} wrongly fires on plural voice: ${copy}`);
  }
});

test('the guard would actually catch the regression it was written for', () => {
  // The exact H1 that shipped on 2026-09-08. If this assertion ever stops
  // failing on that string, the guard has stopped working.
  const regressed = '<h1>I make heavy Salesforce orgs light again.</h1>';
  const text = visible(regressed);
  const caught = SELLS_A_PERSON.some((p) =>
    new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text));
  assert.ok(caught, 'the phrase list no longer catches the copy that caused this file to exist');
});
