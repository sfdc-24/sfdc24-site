/* Visitor access for /conference.
   The access host is a separate service and is not deployed yet.
   Leave enabled false so the live brochure stays unchanged.
   requestUrl is the only endpoint the form posts JSON to.
   gatewaySignInUrl is the placeholder approved visitors use.
   JSON keys: email, name (optional), use_case (fewer than 20 words), fax_number (empty). */
window.SFDC24_CONFERENCE_ACCESS = {
  enabled: false,
  requestUrl: "https://access.invalid/api/conference/access/request",
  gatewaySignInUrl: "https://gateway.invalid/sign-in"
};
