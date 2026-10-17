# What the backend must provide for SFDC24-hosted conferences

For Claude, the backend owner. The Conferences page is a front end only. It does not create a room, authenticate anyone, store a secret, or record.

## What already exists

Build on these. Do not add a second join system beside them.

- `/conference/` is the brochure. It is not the join door. Guests stay closed until the owner records VERIFY and GO. Team entry is the conference gateway.
- `/experience/` is the owner's studio on the conference line. It carries the one owner-labelled link to the gateway (`Join the voice room (owner sign-in)`). No other page may link that origin.
- `/conferences/` is the public handoff. **Start** and **Join** both open `https://converspan.com/room` in the same tab. Neither link adds a name, a company, or a room code.
- `https://converspan.com/room` is already live. It refuses to be framed (`X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`), so the site links to it and does not embed it. Its own headers allow the microphone on that origin (`Permissions-Policy: microphone=(self)`, plus camera and display-capture). Its CSP allows `connect-src` to the room's media host.
- `www.sfdc24.com` is GitHub Pages and currently sends **no** `Content-Security-Policy` header. Do not add a site-wide CSP in this repository as part of the front end. When a room is actually served by sfdc24.com, put the headers on that response from the host.

The page does not dial a number, and it must stay that way. No dial pad, no `tel:` link, no click-to-call, no SIP widget, no outbound calling control.

## 1. Room and session creation

- A create call that returns a room id and a join path **on sfdc24.com** once hosting moves here. Until that exists, Start and Join keep handing off to `https://converspan.com/room`.
- Start creates a session. Join enters an existing code. The front end will not invent a code and will not pre-fill it.
- Do not accept a guest name or company from this page. There is no such field, and the handoff URL has no `name` or `company` query. If the room asks later, those fields start empty.
- Say what expiry, capacity, and a wrong code look like, so the page can show them without guessing.

## 2. Auth

- Owner versus guest. Today the gateway admits only the owner. Guest admission stays closed until the owner records VERIFY and GO, which is what the brochure already says.
- How the browser proves it: cookie or bearer header. No secret in the static site, and no token in the URL.
- What the page should show when auth fails, and how a session ends.

## 3. Domain and CORS

- Allowed browser origins: `https://www.sfdc24.com` and `https://sfdc24.com`.
- State whether `https://converspan.com` must allow those origins while the room stays there, or whether the room moves onto an sfdc24.com path.
- Any callback URL. No open redirect.

## 4. CSP and microphone headers

Supply these on the **hosted room response**, not as a new site-wide policy, and do not add an external CDN.

- `Permissions-Policy` with `microphone=(self)`. Add `camera=(self)` and `display-capture=(self)` only if that room uses them. Leave geolocation, payment, and usb disabled.
- A CSP with `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, and a `connect-src` that names only the media host the room needs. The Converspan room today allows its media host and local dev sockets. Production should list the production host only.
- Do not grant `microphone` to a nested frame.
- Leave every other sfdc24.com response on today's header set until that host change is reviewed on its own.

## 5. The Lou greeting

- The exact words Lou speaks or shows when a room opens, and the audio source if there is one.
- When it is allowed to play: after the visitor is in the room, and not as a recording stored before consent.
- Recording and transcripts stay off until that visitor consents. PIPEDA and the CRTC require consent before either one. The page says so. The backend has to enforce it: no recorder and no transcript job until that session has an explicit consent flag.
- Consent is not a pre-checked box, and it is not a name or a company.

## Out of scope here

Redis, auth secrets, gateway deploys, and any phone or SIP dial-in. Those stay with the backend owner.
