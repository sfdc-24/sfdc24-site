/* Public relay location. Set relayUrl after the Cloud Run deploy.
   The speech key stays on the relay host. */
(function () {
  var cur = window.SFDC24_STT_CONFIG || {};
  if (!cur.relayUrl) {
    window.SFDC24_STT_CONFIG = { relayUrl: "" };
  }
})();
