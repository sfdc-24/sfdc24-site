/* /ops/ diagram loader — joins part-a + part-b (Node tests + browser). */
(function (root) {
  function bootCode(code) {
    var module = { exports: {} };
    var exports = module.exports;
    // eslint-disable-next-line no-eval
    eval(code);
    return module.exports;
  }
  if (typeof module !== "undefined" && module.exports) {
    var fs = require("fs");
    var path = require("path");
    var code = fs.readFileSync(path.join(__dirname, "board-ops.part-a.js"), "utf8") +
      fs.readFileSync(path.join(__dirname, "board-ops.part-b.js"), "utf8");
    module.exports = bootCode(code);
    return;
  }
  function load(url) {
    return fetch(url, { cache: "no-store", credentials: "omit" }).then(function (r) {
      if (!r.ok) throw new Error("part");
      return r.text();
    });
  }
  Promise.all([
    load("/assets/board-ops.part-a.js"),
    load("/assets/board-ops.part-b.js")
  ]).then(function (parts) {
    bootCode(parts[0] + parts[1]);
  }).catch(function (err) {
    if (root && root.console) root.console.error("board-ops load failed", err);
  });
})(typeof window !== "undefined" ? window : null);
