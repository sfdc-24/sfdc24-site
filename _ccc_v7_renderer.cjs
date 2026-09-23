// The realistic regression: someone edits profileHtml() in assets/choice-design-probe.js.
// The static HTML in method/index.html stays correct, so set 1 looks fine. Set 2 is the defect.
// Which gate notices? Served JS is rewritten in flight; no file in the worktree is touched.
const { chromium } = require("playwright-core");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const REPO = path.resolve("C:/Users/salam/Quantum/.ccc-pr120-v7");
const TYPES = { ".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8",".svg":"image/svg+xml",".ico":"image/x-icon" };
function startServer(){const server=http.createServer((req,res)=>{const url=new URL(req.url,"http://127.0.0.1");
  let rel=decodeURIComponent(url.pathname); if(rel.endsWith("/"))rel+="index.html";
  const file=path.join(REPO,rel.replace(/^\/+/,""));
  if(!file.startsWith(REPO)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end("missing");return;}
  res.writeHead(200,{"content-type":TYPES[path.extname(file).toLowerCase()]||"application/octet-stream"});
  res.end(fs.readFileSync(file));});
  return new Promise((r)=>server.listen(0,"127.0.0.1",()=>r({server,origin:`http://127.0.0.1:${server.address().port}`})));}

const S9  = '#choice-design-probe .cd-profile:is(button,a,[role],[tabindex])';
const OLD = '#choice-design-probe .cd-profile button h3';

const SRC = fs.readFileSync(path.join(REPO, "assets", "choice-design-probe.js"), "utf8");
// reintroduce main's defect inside the renderer only
const BAD = SRC
  .replace('\'<article class="cd-profile" data-profile="\' + (index + 1) + \'">\'',
           '\'<button type="button" class="cd-profile" aria-pressed="false" data-profile="\' + (index + 1) + \'">\'')
  .replace('"</article>"', '"</button>"');

(async () => {
  if (BAD === SRC) { console.log("PATCH FAILED - renderer strings did not match, aborting"); return; }
  const { server, origin } = await startServer();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const rows = [];
  try {
    await page.route("**/assets/choice-design-probe.js", (route) =>
      route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: BAD }));
    await page.goto(origin + "/method/#choice-design");
    for (const stage of ["set1 (static HTML)", "set2 (JS-rendered)"]) {
      await page.waitForSelector("#choice-design-probe .cd-profile");
      rows.push({ stage, cards: await page.locator("#choice-design-probe .cd-profile").count(),
        S9: await page.locator(S9).count(), OLD: await page.locator(OLD).count(),
        cardTag: await page.evaluate(() => document.querySelector("#choice-design-probe .cd-profile").tagName) });
      await page.locator("#choice-design-probe [data-cd-pick], #choice-design-probe .cd-profile").first().click();
    }
  } finally { await browser.close(); server.close(); }
  const cols = ["stage","cards","cardTag","S9","OLD"];
  console.log(cols.join("\t"));
  for (const r of rows) console.log(cols.map((c) => r[c]).join("\t"));
})();
