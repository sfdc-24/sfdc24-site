// Every published page shows the site icon in its browser tab. Found on
// 2026-09-24: ten live pages named no icon, so their tabs showed the
// browser's blank default. The list of pages is read from the repository,
// so a new page without an icon fails here.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

const pages = execFileSync('git', ['ls-files', '*.html'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter((f) => f === 'index.html' || f === '404.html' || /^[a-z0-9-]+\/index\.html$/.test(f));

test('the page list is read from the repository', () => {
  expect(pages.length).toBeGreaterThanOrEqual(20);
  expect(pages).toContain('studio/index.html');
});

for (const file of pages) {
  test(`${file} names the site icon, and the icon files it names exist`, () => {
    const html = fs.readFileSync(path.join(root, file), 'utf8');
    const hrefs = [...html.matchAll(/<link\b[^>]*rel="(?:icon|apple-touch-icon)"[^>]*>/g)]
      .map((m) => (m[0].match(/href="([^"]+)"/) || [])[1]);
    expect(hrefs.length, 'at least one icon link').toBeGreaterThan(0);
    const base = 'http://site.test/' + file.replace(/index\.html$/, '');
    for (const href of hrefs) {
      const target = new URL(href, base).pathname;
      expect(fs.existsSync(path.join(root, '.' + target)), file + ' -> ' + target).toBe(true);
    }
  });
}
