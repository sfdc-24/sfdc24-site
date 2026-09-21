const { test, expect } = require("@playwright/test");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const REPO = path.join(__dirname, "..");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function startServer() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.join(REPO, rel.replace(/^\/+/, ""));
    if (!file.startsWith(REPO) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); res.end("missing"); return;
    }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { "content-type": TYPES[ext] || "application/octet-stream" });
    res.end(fs.readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}

async function expectProfileContract(page) {
  // Keep the two-card anchor: a zero-count assertion alone accepts an empty renderer.
  await expect(page.locator('#choice-design-probe .cd-profile')).toHaveCount(2, {timeout:1000});
  await expect(page.locator('#choice-design-probe .cd-profile:is(button,a,[role],[tabindex])')).toHaveCount(0, {timeout:1000});
  for (const profile of [1, 2]) {
    await expect(page.getByRole('heading', {name:`Profile ${profile}`, exact:true})).toBeVisible();
    await expect(page.getByRole('button', {name:`Pick profile ${profile}`, exact:true})).toHaveCount(1);
  }
}

test("choice-design probe stays on Method and does not switch Cobalt", async ({ page }) => {
  const { server, origin } = await startServer();
  try {
    await page.goto(origin + "/method/#choice-design");
    const root = page.locator("#choice-design-probe");
    await expect(root).toBeVisible();
    await expect(page.locator("#choice-design-heading")).toContainText("Choice design");
    await expect(page.locator("[data-cd-status]")).toContainText("Set 1 of 8");

    const cards = page.locator("#choice-design-probe .cd-profile");
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(1)).toContainText("Trust Navy");
    await expectProfileContract(page);
    await page.locator("#choice-design-probe [data-cd-pick]").nth(1).click();

    await expect(page.locator("[data-cd-status]")).toContainText("Set 2 of 8");
    await expect(page.locator("html")).toHaveAttribute("data-palette", "cobalt");
    expect(await page.evaluate(() => document.cookie)).toBe("");
    expect(page.url()).toContain("/method/");
    expect(page.url()).not.toContain("next-deploy");

    for (let i = 2; i <= 8; i++) {
      await expectProfileContract(page);
      await page.locator("#choice-design-probe [data-cd-pick]").first().click();
    }
    await expect(page.locator("[data-cd-tally]")).toBeVisible();
    await expect(page.locator("[data-cd-status]")).toContainText("not a fitted model");
    await expect(page.locator("[data-cd-tally]")).toContainText("Cobalt");
    await expect(page.locator("html")).toHaveAttribute("data-palette", "cobalt");

    await page.locator("[data-cd-again]").click();
    await expect(page.locator("[data-cd-status]")).toContainText("Set 1 of 8");
    await expect(page.locator("#choice-design-probe .cd-profile")).toHaveCount(2);
    await expectProfileContract(page);
  } finally {
    server.close();
  }
});

test("keyboard picks restore focus to the next profile and Again", async ({ page }) => {
  const { server, origin } = await startServer();
  try {
    await page.goto(origin + "/method/#choice-design");
    await page.locator("#choice-design-probe [data-cd-pick]").nth(1).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-cd-status]")).toContainText("Set 2 of 8");
    await expect(page.locator("#choice-design-probe [data-cd-pick]").first()).toBeFocused();

    for (let i = 2; i <= 8; i++) {
      await page.keyboard.press("Enter");
    }
    await expect(page.locator("[data-cd-tally]")).toBeVisible();
    await expect(page.locator("[data-cd-again]")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("[data-cd-status]")).toContainText("Set 1 of 8");
    await expect(page.locator("#choice-design-probe [data-cd-pick]").first()).toBeFocused();
  } finally {
    server.close();
  }
});

test("file:// Method still shows the first catalog pair without a server", async ({ page }) => {
  const file = pathToFileURL(path.join(REPO, "method", "index.html")).href;
  await page.goto(file);
  await expect(page.locator("#choice-design-probe")).toBeVisible();
  await expect(page.locator("#choice-design-probe")).toContainText("What are you working on?");
  await expect(page.locator("#choice-design-probe")).toContainText("Cobalt");
  await expect(page.locator("#choice-design-probe")).toContainText("Trust Navy");
  await expectProfileContract(page);
});

test('mobile pick controls have distinct names, usable targets and no horizontal overflow', async ({page}) => {
  const {server, origin} = await startServer();
  try {
    await page.setViewportSize({width:390,height:844});
    await page.goto(origin + '/method/#choice-design');
    await expectProfileContract(page);
    for (const profile of [1,2]) {
      const box = await page.getByRole('button', {name:`Pick profile ${profile}`,exact:true}).boundingBox();
      expect(box.width).toBeGreaterThanOrEqual(44);
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }
  } finally { server.close(); }
});

for (const mutant of ['button', 'role-link', 'empty']) {
  test(`card contract rejects the ${mutant} renderer regression`, async ({page}) => {
    const {server,origin} = await startServer();
    try {
      let source = fs.readFileSync(path.join(REPO,'assets/choice-design-probe.js'),'utf8');
      if (mutant === 'button') {
        source = source.replace("return '<article class=", "return '<button type=\"button\" class=").replace('"</article>"','"</button>"');
      } else if (mutant === 'role-link') {
        source = source.replace("return '<article class=", "return '<article role=\"link\" tabindex=\"0\" class=");
      } else {
        source = source.replace('function profileHtml(attrs, index) {','function profileHtml(attrs, index) { return "";');
      }
      await page.route('**/assets/choice-design-probe.js', route => route.fulfill({contentType:'text/javascript',body:source}));
      await page.goto(origin + '/method/#choice-design');
      await expect(page.locator('[data-cd-status]')).toContainText('Set 1 of 8');
      await expect(page.locator('#choice-design-probe .cd-profile')).toHaveCount(mutant === 'empty' ? 0 : 2);
      await expect(expectProfileContract(page)).rejects.toThrow();
    } finally { server.close(); }
  });
}
