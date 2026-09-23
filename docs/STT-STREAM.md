# Three-minute streaming speech

Public page: [https://www.sfdc24.com/stream/](https://www.sfdc24.com/stream/)

Linked from Method: [https://www.sfdc24.com/method/#stream](https://www.sfdc24.com/method/#stream)

The homepage ask bar is unchanged. This is a separate panel.

## What a visitor gets

1. Start opens the microphone and keeps it open. Playback is not browser Web Speech, so a pause does not cut the line.
2. A clock shows `3:00` and counts down.
3. In the last 30 seconds the clock changes color and the page says “Thirty seconds left.”
4. At `0:00` the stream stops, the page thanks them, and the clock resets to `3:00` for another session.
5. Name, company, email, phone, the note, and the transcript are posted as one lead.

Audio path: `getUserMedia` → AudioWorklet (16 kHz mono linear16) → authenticated websocket → this relay → Deepgram Nova-3.

`DEEPGRAM_API_KEY` is an environment variable on the relay host only. Cloud Run and any other remote relay must set that name in the service environment or Secret Manager. Do not commit the value. It must not be placed in the browser, in `stream/config.js`, in git, or in chat.

## Relay

Source: `services/stt-relay/`

| Env | Required | Purpose |
|---|---|---|
| `DEEPGRAM_API_KEY` | yes, for live speech | Deepgram secret. Header `Authorization: Token …` on the Nova-3 socket. |
| `RELAY_AUTH_SECRET` | yes | HMAC secret for browser session tokens and for the signed transcript receipt. Blank refuses sessions. It is not the admin password. |
| `RELAY_ADMIN_SECRET` | yes, to read the development file | Separate from the signing secret. `GET /v1/leads` accepts only this value. |
| `OMNISTUDIO_LEAD_URL` | no | Where to POST the lead JSON. Empty means staging sink only. |
| `OMNISTUDIO_LEAD_TOKEN` | no | Sent as `Authorization: Bearer …` when the URL is set. |
| `LEAD_SINK_PATH` | no | Development-only JSONL file. Default `/tmp/stt-leads.jsonl`. Not a production queue. |
| `STT_RUNTIME` | see hosted rule | `development` or `production`. An omitted value is development only when `K_SERVICE` is unset. |
| `ALLOWED_ORIGINS` | no | Comma-separated. Default includes `https://www.sfdc24.com` and `https://sfdc24.com`. |
| `STT_MAX_SECONDS` | no | Default 180. Values above 180 are clamped to 180. |
| `STT_WARN_SECONDS` | no | Default 30. |
| `STT_FAKE_UPSTREAM` | no | Set to `1` only for a local development process. Production and Cloud Run refuse it. |
| `K_SERVICE` | set by Cloud Run | When this is non-empty the process uses production safeguards even if `STT_RUNTIME` is omitted or set to `development`. |

`STT_FAKE_UPSTREAM=1` skips Deepgram and types one fixed line. A production process, including any process where `K_SERVICE` is set, rejects that flag at session admission and in provider selection. It does not forward the canned line.

### Hosted runtime

A laptop with `K_SERVICE` unset treats an omitted `STT_RUNTIME`, or `STT_RUNTIME=development`, as the offline development process. The JSONL file and `GET /v1/leads` exist only there.

Cloud Run sets `K_SERVICE`. On that host an omitted value and `STT_RUNTIME=development` both use production safeguards: no development admin listing, and no session unless `OMNISTUDIO_LEAD_URL` is set. An unrecognized `STT_RUNTIME` value returns `runtime_invalid` on every host, including a laptop, instead of silently becoming development.

### Cloud Run

From this repo, after `gcloud` is logged into the deploy project:

```bash
gcloud run deploy sfdc24-stt-relay \
  --source services/stt-relay \
  --region us-central1 \
  --allow-unauthenticated \
  --timeout 300 \
  --set-env-vars "^|^STT_RUNTIME=production|RELAY_AUTH_SECRET=REPLACE|RELAY_ADMIN_SECRET=REPLACE|OMNISTUDIO_LEAD_URL=https://REPLACE.my.salesforce.com/services/apexrest/stt/lead/v1|ALLOWED_ORIGINS=https://www.sfdc24.com,https://sfdc24.com" \
  --set-secrets "DEEPGRAM_API_KEY=DEEPGRAM_API_KEY:latest"
```

The `^|^` prefix is gcloud's custom delimiter. `ALLOWED_ORIGINS` contains commas, so a comma delimiter would split the origin list into a broken extra variable.

`--timeout` must be longer than 180 seconds or Cloud Run will cut the socket early.

`--allow-unauthenticated` lets the browser open a session. The websocket still requires a short-lived HMAC token from `POST /v1/session`, and that route rejects origins that are not on the allowlist. The Deepgram key is not in the token.

If Secret Manager is not wired yet, pass the speech key with `--set-env-vars DEEPGRAM_API_KEY=...` on the service itself. That value stays on the deploy host. Do not commit it. Prefer Secret Manager.

The committed template is `services/stt-relay/.env.example`. Every secret in that file is empty. `.env` is gitignored. Never commit one.

Local VANLAS smoke does not need the key pasted anywhere. If `DEEPGRAM_API_KEY` is not already in the process environment, the relay and `scripts/smoke_deepgram.py` read that one name from `C:\Users\salam\Quantum\Blackboard\.env` (also the WSL path `/mnt/c/Users/salam/Quantum/Blackboard/.env`). `BLACKBOARD_ENV` overrides the path. A value already in the process environment wins, which is what Cloud Run uses. The Blackboard file is not copied into the image.

```bash
cd services/stt-relay
python3 scripts/smoke_deepgram.py
# RELAY_AUTH_SECRET and RELAY_ADMIN_SECRET must already be set.
# A blank signing secret refuses sessions. There is no built-in fallback.
# Leave STT_RUNTIME unset or set it to development for this local process.
python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8765
```

`smoke_deepgram.py` exits 2 when the name is missing from both the process environment and that file. It prints the failure type and the path it used. It does not print the key.

### Point the page at the relay

Edit `stream/config.js` after the host exists:

```javascript
window.SFDC24_STT_CONFIG = { relayUrl: "https://sfdc24-stt-relay-XXXX.a.run.app" };
```

Leave `relayUrl` empty until then. The page shows the 3:00 clock and refuses to start, with the line “Streaming relay is not set on this host yet.”

## Lead contract (`stt-lead-v1`)

`POST /v1/leads` with the session token returns the lead the relay heard. A development response includes `"durable": false`. Shape:

```json
{
  "source": "sfdc24-stream-stt",
  "contract": "stt-lead-v1",
  "session_id": "…",
  "duration_s": 180,
  "cap_reason": "elapsed",
  "max_seconds": 180,
  "visitor": {"name": "", "company": "", "email": "", "phone": ""},
  "need": "",
  "transcript": "",
  "summary": "",
  "salesforce": {
    "object": "Lead",
    "LastName": "Callback",
    "Company": "Unknown",
    "Email": "",
    "Phone": "",
    "LeadSource": "www.sfdc24.com/stream",
    "Description": ""
  },
  "omnistudio": {"contract": "stt-lead-v1", "status": "staged"}
}
```

`cap_reason` is `elapsed`, `visitor_stop`, `disconnect`, or `upstream_lost`.

Emails and phone numbers spoken in the transcript fill empty form fields. The transcript stored is the one the relay heard, not a body the browser invents.

### Development sink (no Omnistudio credentials)

When `OMNISTUDIO_LEAD_URL` is empty and `STT_RUNTIME` is not `production`, `omnistudio.status` is `staged` and the HTTP body says `"durable": false`. The row is written to `LEAD_SINK_PATH` on that process only. That file is not shared across instances and is not kept by a restart of an ephemeral disk. A successful response is not a claim that the transcript was retained anywhere else.

`POST /v1/leads` uses the closed session in this process, or a receipt signed by `RELAY_AUTH_SECRET` that the `cap` message gave the browser. If neither is present, the response is `409 session_not_retained`. It does not return a lead with an empty transcript. A local JSONL row is not accepted as proof.

`STT_RUNTIME=production` without `OMNISTUDIO_LEAD_URL` refuses `POST /v1/session` with `production_forwarder_missing`. Production does not fall back to the JSONL file. This repo does not provision another database.

Verify a development process:

```bash
curl -sS -H "X-Relay-Admin: $RELAY_ADMIN_SECRET" \
  https://RELAY_HOST/v1/leads
```

`GET /v1/leads` without that header returns 401. The header value is `RELAY_ADMIN_SECRET`, not `RELAY_AUTH_SECRET` and not the speech key. In production the route returns `development_sink_disabled` because the file is not the callback queue.

`GET /healthz` reports booleans and `runtime` / `lead_sink`. It does not echo secrets.

### Omnistudio handoff

Repo: https://github.com/sfdc-24/Omnistudio

Checked at ship time: `Omnistudio-Claude/force-app` contains `SLARuleService` and a Case object. There is no Lead intake, no Integration Procedure, and no Experience Cloud form. This repo does not have Salesforce credentials, so nothing was deployed to the DEV org.

When the org is available:

1. Deploy `services/stt-relay/handoff/SttLeadIntake.cls` (and its meta and test) into `Omnistudio-Claude/force-app/main/default/classes/`.
2. `sf project deploy start --source-dir force-app --target-org <dev-alias>`
3. Give the integration user access to that Apex class and to Lead create.
4. Set the relay:

```bash
OMNISTUDIO_LEAD_URL=https://<mydomain>.my.salesforce.com/services/apexrest/stt/lead/v1
OMNISTUDIO_LEAD_TOKEN=<salesforce access token or a token minted for that user>
```

The relay POSTs the full `stt-lead-v1` JSON and does not follow redirects. The Apex class reads `salesforce.LastName`, `Company`, `Email`, `Phone`, `LeadSource`, and `Description`, and inserts a Lead. `omnistudio.status` is `forwarded`, and the HTTP body says `"durable": true`, only when the handoff returns 2xx and a JSON object whose `ok` is not `false`. A redirect, a non-2xx status, or a body that is not that object is `staged_forward_failed`. In production that is HTTP 502 with `"durable": false`. In development the same failure stays on the JSONL file and can be posted again to that process.

The `cap` message includes `receipt`, an HMAC over the server transcript. The browser sends it back on `POST /v1/leads` so a different instance can verify the words without a shared disk. The receipt is not a storage service. If the browser never posts, a production process does not keep a durable copy.

Abandoned rows in process memory are dropped once `expires_at` passes and the socket is no longer live. A live socket is kept. After the row is gone, the signed receipt is what another request can verify. That bound is not a new database and not a retention policy.

An Omnistudio Integration Procedure can sit in front of that URL later. Point `OMNISTUDIO_LEAD_URL` at the procedure’s public integration endpoint if that is the path the DEV org wants. The JSON body stays `stt-lead-v1`.

## Browser session

`POST /v1/session` (Origin must be allowed) returns `token`, `stream_path`, `max_seconds` (≤ 180), `warn_seconds`.

The page opens `wss://<relay>/v1/stream` and sends `{"type":"auth","token":"…"}` as the first message. The token is not put on the URL. It expires with `STT_SESSION_TTL` (default 240 seconds).

Then the page sends binary PCM frames. The relay sends `ready`, `transcript`, `warn`, and `cap`.

## Tests

```bash
PYTHONPATH=services/stt-relay python3 -m unittest discover -s services/stt-relay/tests -v
node --test tests/stt_session.cjs
```

CI workflow: `.github/workflows/stt-stream.yml`.
