const { test, expect } = require("@playwright/test");
const { createServer } = require("node:http");
const { readFile, stat } = require("node:fs/promises");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const ASSISTANT_URL = process.env.SFDC24_STAGING_ASSISTANT_URL || "";
const TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

let server;
let baseUrl;

test.skip(!ASSISTANT_URL, "set SFDC24_STAGING_ASSISTANT_URL to run the live staging receipt");
test.setTimeout(45000);

test.beforeAll(async () => {
  const parsed = new URL(ASSISTANT_URL);
  if (parsed.protocol !== "https:" || parsed.hostname !== "script.google.com" ||
      !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(parsed.pathname) ||
      parsed.username || parsed.password || parsed.port || parsed.hash ||
      parsed.searchParams.get("view") !== "home" || [...parsed.searchParams].length !== 1) {
    throw new Error("staging assistant URL must be an exact Apps Script /exec?view=home URL");
  }

  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      let target = path.resolve(ROOT, "." + pathname);
      if (!target.startsWith(ROOT + path.sep) && target !== ROOT) throw new Error("outside root");
      if ((await stat(target)).isDirectory()) target = path.join(target, "index.html");
      let body = await readFile(target);
      if (target === path.join(ROOT, "index.html")) {
        const html = body.toString("utf8");
        const matches = html.match(/data-assistant-url="[^"]+"/g) || [];
        if (matches.length !== 1) throw new Error("expected one assistant URL in the site shell");
        body = Buffer.from(html.replace(matches[0],
          `data-assistant-url="${ASSISTANT_URL.replaceAll("&", "&amp;")}"`));
      }
      response.writeHead(200, { "content-type": TYPES[path.extname(target)] || "application/octet-stream" });
      response.end(body);
    } catch (error) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = "http://127.0.0.1:" + server.address().port;
});

test.afterAll(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

for (const scenario of [
  { name: "mobile", viewport: { width: 390, height: 844 } },
  { name: "desktop", viewport: { width: 1280, height: 800 } }
]) {
  test(scenario.name + " shell accepts the real staged assistant handshake", async ({ page }) => {
    await page.setViewportSize(scenario.viewport);
    await page.goto(baseUrl + "/");

    const shell = page.locator("[data-assistant-shell]");
    const frame = page.getByTestId("assistant-frame");
    await expect(page.getByTestId("assistant-state-label")).toBeHidden({ timeout: 30000 });
    await expect(shell).toHaveAttribute("aria-busy", "false");
    await expect(frame).not.toHaveAttribute("aria-hidden", "true");
    await expect(frame).not.toHaveAttribute("tabindex", "-1");

    // Apps Script may put the rendered HTML service document inside an extra
    // Google wrapper frame. The parent nonce gate above is tied to the outer
    // frame; locate the actual reception document across the resulting tree.
    let receptionFrame;
    await expect.poll(async () => {
      for (const candidate of page.frames()) {
        try {
          if (await candidate.locator("#box").count()) {
            receptionFrame = candidate;
            return true;
          }
        } catch (error) {
          // A redirect can detach an intermediate Google frame; poll the fresh tree.
        }
      }
      return false;
    }, { timeout: 30000, message: "staged reception document did not appear in the frame tree" })
      .toBe(true);
    await expect(receptionFrame.locator("#box")).toBeVisible();
    await expect(receptionFrame.locator(".statusline")).toContainText("online");

    const src = new URL(await frame.getAttribute("src"));
    expect(src.origin + src.pathname).toBe(new URL(ASSISTANT_URL).origin + new URL(ASSISTANT_URL).pathname);
    expect(src.searchParams.get("view")).toBe("home");
    expect(src.searchParams.get("ready_nonce")).toMatch(/^[0-9a-f]{32}$/);
    expect(src.searchParams.get("embed_attempt")).toBe("1");
  });
}
