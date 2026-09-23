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

`DEEPGRAM_API_KEY` is read only on the relay host. It must not be placed in the browser, in `stream/config.js`, or in git.

## Relay

Source: `services/stt-relay/`

| Env | Required | Purpose |
|---|---|---|
| `DEEPGRAM_API_KEY` | yes, for live speech | Deepgram secret. Header `Authorization: Token …` on the Nova-3 socket. |
| `RELAY_AUTH_SECRET` | yes, in production | HMAC secret for browser session tokens and for `GET /v1/leads`. |
| `OMNISTUDIO_LEAD_URL` | no | Where to POST the lead JSON. Empty means staging sink only. |
| `OMNISTUDIO_LEAD_TOKEN` | no | Sent as `Authorization: Bearer …` when the URL is set. |
| `LEAD_SINK_PATH` | no | JSONL file. Default `/tmp/stt-leads.jsonl` (one Cloud Run instance, ephemeral). |
| `ALLOWED_ORIGINS` | no | Comma-separated. Default includes `https://www.sfdc24.com` and `https://sfdc24.com`. |
| `STT_MAX_SECONDS` | no | Default 180. Values above 180 are clamped to 180. |
| `STT_WARN_SECONDS` | no | Default 30. |
| `STT_FAKE_UPSTREAM` | no | Set to `1` only for tests. Never on the public relay. |

`STT_FAKE_UPSTREAM=1` skips Deepgram and types one fixed line. Do not set it on Cloud Run.

### Cloud Run

From this repo, after `gcloud` is logged into the deploy project:

```bash
gcloud run deploy sfdc24-stt-relay \
  --source services/stt-relay \
  --region us-central1 \
  --allow-unauthenticated \
  --timeout 300 \
  --set-env-vars "RELAY_AUTH_SECRET=REPLACE,ALLOWED_ORIGINS=https://www.sfdc24.com,https://sfdc24.com" \
  --set-secrets "DEEPGRAM_API_KEY=DEEPGRAM_API_KEY:latest"
```

`--timeout` must be longer than 180 seconds or Cloud Run will cut the socket early.

`--allow-unauthenticated` lets the browser open a session. The websocket still requires a short-lived HMAC token from `POST /v1/session`, and that route rejects origins that are not on the allowlist. The Deepgram key is not in the token.

If Secret Manager is not wired yet, pass the speech key with `--set-env-vars` on the service and do not commit it. Prefer Secret Manager.

Local run:

```bash
cd services/stt-relay
export DEEPGRAM_API_KEY="…"
export RELAY_AUTH_SECRET="…"
python3 -m uvicorn app.main:app --host 127.0.0.1 --port 8765
```

### Point the page at the relay

Edit `stream/config.js` after the host exists:

```javascript
window.SFDC24_STT_CONFIG = { relayUrl: "https://sfdc24-stt-relay-XXXX.a.run.app" };
```

Leave `relayUrl` empty until then. The page shows the 3:00 clock and refuses to start, with the line “Streaming relay is not set on this host yet.”

## Lead contract (`stt-lead-v1`)

`POST /v1/leads` with the session token returns the stored lead. Shape:

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

### Staging sink (no Omnistudio credentials)

When `OMNISTUDIO_LEAD_URL` is empty, `omnistudio.status` is `staged`. The same object is appended to `LEAD_SINK_PATH` (one row per session).

Verify:

```bash
curl -sS -H "X-Relay-Admin: $RELAY_AUTH_SECRET" \
  https://RELAY_HOST/v1/leads
```

`GET /v1/leads` without that header returns 401. The header value is `RELAY_AUTH_SECRET`, not the Deepgram key.

`GET /healthz` reports `speech_configured` and `omnistudio_configured` as booleans and does not echo secrets.

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

The relay POSTs the full `stt-lead-v1` JSON. The Apex class reads `salesforce.LastName`, `Company`, `Email`, `Phone`, `LeadSource`, and `Description`, and inserts a Lead. A 2xx response is stored as `omnistudio.status = forwarded`. A failure stays on the JSONL sink as `staged_forward_failed` and can be posted again.

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
