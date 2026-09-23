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
    "LeadSource": "www.sfdc24.com/stream",
    "Description": ""
  },
  "omnistudio": {"contract": "stt-lead-v1", "status": "staged"}
}
```

`cap_reason` is `elapsed`, `visitor_stop`, `disconnect`, or `upstream_lost`.

Emails and phone numbers spoken in the transcript fill empty form fields. The transcript stored is the one the relay heard, not a body the browser invents. A blank name or company is omitted from `salesforce`. `LastName` `Callback` and `Company` `Unknown` are insert defaults in the handoff, applied only when that Lead is created. A later POST writes `LastName`, `Company`, `Email`, or `Phone` only when the new value is non-blank, so a phone-only or email-only retry keeps the stored name and company. A supplied name or company on a later POST is a correction. `LeadSource` in this source is `www.sfdc24.com/stream`. That string is source attribution. Whether the org picklist accepts it is an authorized-org check. This source does not substitute a different value.

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
2. Deploy `services/stt-relay/handoff/objects/Lead/fields/Stt_Session_Id__c.field-meta.xml` onto Lead. It is a unique external id. These Apex and field sources were not executed against an org.
3. `sf project deploy start --source-dir force-app --target-org <dev-alias>`
4. Give the integration user access to that Apex class and to Lead create and update.
5. Set the relay:

```bash
OMNISTUDIO_LEAD_URL=https://<mydomain>.my.salesforce.com/services/apexrest/stt/lead/v1
OMNISTUDIO_LEAD_TOKEN=<salesforce access token or a token minted for that user>
```

The relay POSTs the full `stt-lead-v1` JSON and does not follow redirects. The Apex class reads `salesforce.LastName`, `Company`, `Email`, `Phone`, `LeadSource`, and `Description`. It inserts one Lead on `Stt_Session_Id__c` and updates that same row when the id already exists. A second POST for that session returns the same Lead id. A non-blank phone, email, name, or company on a later POST is written onto that Lead. A blank or omitted contact field is left as stored. `Callback` and `Unknown` are used only on insert. A different `session_id` is a different Lead. A missing session id is rejected before DML. `omnistudio.status` is `forwarded`, and the HTTP body says `"durable": true`, only when the handoff returns 2xx and a JSON object with boolean `ok: true`, `contract: "stt-lead-v1"`, `idempotency: "session_id"`, a non-empty string `id`, and the same `session_id` as the lead. `{}`, `{"error":"not_saved"}`, `{"ok":0}`, and `{"ok":"false"}` are not that acknowledgment. A body that omits `idempotency` is not durable. A redirect, a non-2xx status, or any other body is `staged_forward_failed`. In production that is HTTP 502 with `"durable": false`. A timeout after the request was sent is `handoff_unknown`: the ack was lost, the retry sends the same session id, and the upsert does not insert a second Lead. A connection failure before a write stays retryable and can still insert. The development JSONL file is not this idempotency record. In development a failed forward stays on that file and can be posted again to that process.

The `cap` message includes `receipt`, an HMAC over the server transcript. The browser sends it back on `POST /v1/leads` so a different instance can verify the words without a shared disk. The receipt is not a storage service. If the browser never posts, a production process does not keep a durable copy.

If the socket closes or errors while the page is still listening, the page keeps the draft and does not say the callback was saved. It waits 2.5 seconds, long enough for this process to finish the one-second finalize and the one-second drain, then posts the token. `409 session_not_retained` is retried once. A second failure says the transcript did not reach the desk. A `cap` that arrives during that wait is the receipt on the post. Another instance, without that receipt, still returns `409`. The page does not send the words on the screen as the server transcript. Starting another session stops the previous microphone, worklet, and audio context before the new session replaces them, and cancels that recovery. A flush that finishes afterward does not stop the new session. The earlier response does not change the new session.

Abandoned rows in process memory are dropped once `expires_at` passes and the socket is no longer live. A live socket is kept. After the row is gone, the signed receipt is what another request can verify. That bound is not a new database and not a retention policy.

A session token opens one stream on the process that holds the open row. After that stream is accepted, the same token does not open another provider connection on that process, including after the lead POST drops the row. The signed receipt can still submit the lead. This memory is not cross-instance replay protection. A production process that does not hold the open row refuses the stream instead of inventing a shared store.

That refusal is kept until the token expiry recorded when the stream was accepted. Spent ids are dropped only after that expiry, and only when the socket is not live. Until then a replay is refused. The map is process memory, not a shared replay service.

On Stop, the relay bounds provider `Finalize` to one second and then drains for one second. Words already received are kept, and the `cap` is sent even when finalization stalls. That pair stays inside the browser's 2.5 second cap fallback. The provider close after the cap is also bounded to one second, so a hung close does not hold the browser socket. A final transcript that arrives during the drain is still included.

## Production exposure

The in-memory limit of 30 sessions an hour is per process. It is not a host-level quota. A second process does not see the first process's count. `Origin` is not a credential. `POST /v1/session` in production returns `503 production_exposure_blocked` until an operator-approved host-level quota exists outside this relay. There is no environment switch that marks the gate approved. Local development, with `K_SERVICE` unset and `STT_RUNTIME` omitted or `development`, still opens sessions.

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
