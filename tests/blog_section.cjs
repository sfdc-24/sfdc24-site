// /blog/ is a draft section. It is not in the shared navigation.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const DISCLAIMER = 'sfdc24.com is an independent community resource for Salesforce customers, consultants and developers, run by Abdus Salam, a certified Salesforce Sales Cloud Consultant, with help from AI agents. It is not affiliated with, endorsed by, or sponsored by Salesforce, Inc., and does not represent or speak for Salesforce. Salesforce, Sales Cloud and related marks are trademarks of Salesforce, Inc.';
const POSTS = [
  'blog/a-quiet-note/index.html',
  'blog/a-small-diagram/index.html',
  'blog/a-figure/index.html',
];

function read(rel) {
  return fs.readFileSync(path.join(REPO, rel), 'utf8');
}

test('the blog is not in the shared navigation', () => {
  const chrome = read('assets/chrome.js');
  assert.doesNotMatch(chrome, /\/blog\//, 'chrome.js footer must not list the blog yet');
  assert.doesNotMatch(read('index.html'), /href="\/blog\//);
});

test('the index is draft cards with a thumbnail, date, and two-line summary', () => {
  const html = read('blog/index.html');
  assert.equal((html.match(/class="blog-card"/g) || []).length, 3);
  assert.equal((html.match(/<img /g) || []).length, 3);
  assert.equal((html.match(/<time /g) || []).length, 3);
  assert.equal((html.match(/class="summary"/g) || []).length, 3);
  assert.match(html, /DRAFT/);
  assert.match(html, /noindex/);
  assert.ok(html.includes(DISCLAIMER));
});

test('the palette is teal, text, and copper', () => {
  const css = read('blog/blog.css');
  assert.match(css, /#0c4f4b/);
  assert.match(css, /#1a2330/);
  assert.match(css, /#8a3e12/);
});

test('each draft post has the disclaimer, a reading time, and no hype', () => {
  for (const rel of POSTS) {
    const html = read(rel);
    assert.match(html, /DRAFT/, rel);
    assert.match(html, /data-reading-time/, rel);
    assert.match(html, /data-blog-article/, rel);
    assert.ok(html.includes(DISCLAIMER), rel);
    assert.match(html, /\/blog\/blog\.js/, rel);
    const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
    assert.doesNotMatch(main, /revolutionary|world-class|!/i, rel);
  }
});

test('the diagram post renders Mermaid and keeps a caption', () => {
  const html = read('blog/a-small-diagram/index.html');
  assert.match(html, /class="mermaid"/);
  assert.match(html, /mermaid@11\.4\.1/);
  assert.match(html, /<figcaption>/);
});

test('the figure post supports an inline drawing and a picture, each with a caption', () => {
  const html = read('blog/a-figure/index.html');
  const article = html.slice(html.indexOf('<article'), html.indexOf('</article>'));
  assert.match(article, /<svg /);
  assert.match(article, /<img /);
  assert.equal((article.match(/<figcaption>/g) || []).length, 2);
});
