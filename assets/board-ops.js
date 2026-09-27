/* /ops/ diagram loader — joins part-a/b/c (Node tests + browser). */
(function (root) {
  var PARTS = ["board-ops.part-a.js", "board-ops.part-b.js", "board-ops.part-c.js"];
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
      return fs.readFileSync(path.join(__dirname, name), "utf8");
    }).join("");
    module.exports = bootCode(code);
    return;
  }
  function load(url) {
    return fetch(url, { cache: "no-store", credentials: "omit" }).then(function (r) {
      if (!r.ok) throw new Error("part");
      return r.text();
    });
  }
  Promise.all(PARTS.map(function (name) { return load("/assets/" + name); })).then(function (parts) {
    bootCode(parts.join(""));
  }).catch(function (err) {
    if (root && root.console) root.console.error("board-ops load failed", err);
  });
})(typeof window !== "undefined" ? window : null);
