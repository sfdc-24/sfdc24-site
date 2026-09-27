/* /ops/ diagram loader — joins part-a/b/c (Node tests + browser). */
(function (root) {
  var PARTS = ["board-ops.part-a.js", "board-ops.part-b.js", "board-ops.part-c.js"];
  function decodePart(text) {
    if (text.slice(0, 7) !== "ZLIB64:") return text;
    var b64 = text.slice(7);
    if (typeof require !== "undefined") {
      var zlib = require("zlib");
      return zlib.inflateSync(Buffer.from(b64, "base64")).toString("utf8");
    }
    throw new Error("ZLIB64 requires sync inflate in this environment");
  }
  async function decodePartAsync(text) {
    if (text.slice(0, 7) !== "ZLIB64:") return text;
    var b64 = text.slice(7);
    var bin = Uint8Array.from(atob(b64), function (ch) { return ch.charCodeAt(0); });
    var stream = new Blob([bin]).stream().pipeThrough(new DecompressionStream("deflate"));
    return await new Response(stream).text();
  }
  function bootCode(code) {
    var module = { exports: {} };
    var exports = module.exports;
    eval(code);
    return module.exports;
  }
  if (typeof module !== "undefined" && module.exports) {
    var fs = require("fs");
    var path = require("path");
    var code = PARTS.map(function (name) {
      return decodePart(fs.readFileSync(path.join(__dirname, name), "utf8"));
    }).join("");
    module.exports = bootCode(code);
    return;
  }
  function load(url) {
    return fetch(url, { cache: "no-store", credentials: "omit" }).then(function (r) {
      if (!r.ok) throw new Error("part");
      return r.text();
    }).then(decodePartAsync);
  }
  Promise.all(PARTS.map(function (name) { return load("/assets/" + name); })).then(function (parts) {
    bootCode(parts.join(""));
  }).catch(function (err) {
    if (root && root.console) root.console.error("board-ops load failed", err);
  });
})(typeof window !== "undefined" ? window : null);
