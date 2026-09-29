# Conference flow

## Guest join

Tomorrow's path is the conference page and a join link. Experience Cloud is not required. Sign-in is not required. Nothing is emailed. The owner may receive the link later and share it.

1. `/conference/create/` mints one single-use code and shows `https://www.sfdc24.com/conference/#c=` plus that code.
2. The link opens `/conference/`. The code is on the page. Join with code asks for the microphone, then `POST /v1/join` mints the LiveKit JWT. One human joiner. The room opens on that page. It is not inside Salesforce.
3. `https://portal.sfdc24.com/` stays optional. If it is used later, `POST /v1/enter` still checks a last name or an email and hands off to `/conference/room/` without putting the JWT in the URL. That screen is not required for the join link.
4. The host code is resolved on the server and is not published here.

This repository does not put the media path inside Salesforce.

# Conference Event handoff

Conferences are Salesforce Events. This site does not call Salesforce by itself.
The conference gate queues one Event when a conference code is minted. Claude
owns the Omnistudio DEV write path: deploy the stub in `handoff/` and point
the gate at that endpoint. This repository has no Salesforce credential and
does not deploy.

## Contract `conference-event-v1`

The gate POSTs this JSON. It does not follow redirects. A durable accept is
HTTP 2xx and a JSON object with boolean `ok: true`, `contract:
"conference-event-v1"`, `idempotency: "conference_code"`, a non-empty `id`,
and the same `code`.

```json
{
  "contract": "conference-event-v1",
  "code": "ABCD2345",
  "host_email": "abdus@sfdc24.com",
  "agent_reference": "Dr. Ada",
  "knowledge_ref": "https://github.com/sfdc-24/conference/tree/main/docs/okf",
  "who": {"object": "Contact", "Email": "ada@example.com", "Name": "Ada Lovelace"},
  "salesforce": {
    "object": "Event",
    "Subject": "Hear the floor once",
    "Description": "Agent reference name: Dr. Ada\nConference code: ABCD2345\nHost: abdus@sfdc24.com\nKnowledge: https://github.com/sfdc-24/conference/tree/main/docs/okf",
    "OwnerEmail": "abdus@sfdc24.com"
  }
}
```

`what` is present only when the mint request includes a 15- or 18-character
`account_id`, `campaign_id`, or `opportunity_id`. The create form does not
collect those ids. The stub writes at most one `WhatId`, in this order:
Opportunity, Account, Campaign. Contact is matched by email, then by name.
No match means the Event is still inserted and the email and name stay in
the payload. `Subject` is the Conference Objective. `Description` holds the
knowledge reference, the agent reference name, the conference code, and the
host mailbox. The knowledge reference defaults to the public conference tree
already cited in `data/ops-delivery.json`. `CONFERENCE_KNOWLEDGE_REF` may
replace it with another https URL. The browser response does not include
that URL or the word used in the path.

The stub sets `StartDateTime` to the handoff time and `EndDateTime` thirty
minutes later because the gate has no scheduled start. A repeated POST for
the same conference code updates that Event. It does not insert a second one.

## When the org is available

Claude deploys, from `Omnistudio-Claude/force-app`:

1. `handoff/ConferenceEventIntake.cls` and its meta and test.
2. `handoff/objects/Event/fields/Conference_Code__c.field-meta.xml`.

```bash
sf project deploy start --source-dir force-app --target-org <dev-alias>
```

Then set the gate, with a token minted for that integration user. Do not
commit either value.

```bash
OMNISTUDIO_EVENT_URL=https://<mydomain>.my.salesforce.com/services/apexrest/conference/event/v1
OMNISTUDIO_EVENT_TOKEN=<salesforce access token or a token minted for that user>
```

An Omnistudio Integration Procedure can sit in front of that URL later. The
JSON body stays `conference-event-v1`.

## Without those values

`event.status` is `staged` and `durable` is false. The row lives in this
process only. A restart drops it. The page says the Event was queued and that
Salesforce has not stored it. A bad URL or a handoff that does not return the
ack above stays `staged_forward_failed`. The conference code is still minted.

# P0

Conference codes are single-use: one human joiner, and the code is spent only
after a LiveKit JWT is minted. Tomorrow's path is the conference page and the
join link. Experience Cloud is not required, and sign-in is not required.
`POST /v1/enter` remains available for an optional portal check. It returns
`room_path` with a one-time handoff fragment and does not return the JWT.
The Salesforce Event stores the conference code as its external id and does
not store a room token, a `wss://` URL, a handoff, or a URL that carries
`token=`. No email and no calendar invite is sent. This change stays a draft.

# Invite draft

Hard hold: create, join, and the invite preview are internal testing only.
This gate does not send email and does not create a Google Calendar invite
for an external guest. Minting shows a preview. `POST /v1/invites`
returns that same preview with `status: "draft"`, `sent: false`, and
`reason: "held"`. `confirm: true` does not send. A configured
`GMAIL_INVITE_URL` or `CALENDAR_INVITE_URL`, and a start time on the draft,
do not send. The create page has no send button. `Keep draft` stays in the
browser and does not call the gate.

The draft title is the Conference Objective. The description holds the agent
reference name, the join link `https://www.sfdc24.com/conference/#c=` plus
the code, and the conference code. The room is LiveKit on that page. The
draft has no clock time. Nothing is emailed.

The shapes below are the contract for a later sender. This process does not
POST them.

## Gmail body

```json
{
  "to": "ada@example.com",
  "subject": "Hear the floor once",
  "body": "Agent reference name: Dr. Ada\nJoin link: https://www.sfdc24.com/conference/#c=ABCD2345\nLiveKit room: on the conference page. Not inside Salesforce.\nConference code: ABCD2345\nNo sign-in is required. One joiner. Nothing is emailed. The owner may share the link later."
}
```

## Calendar body

```json
{
  "summary": "Hear the floor once",
  "description": "Agent reference name: Dr. Ada\nJoin link: https://www.sfdc24.com/conference/#c=ABCD2345\nLiveKit room: on the conference page. Not inside Salesforce.\nConference code: ABCD2345\nNo sign-in is required. One joiner. Nothing is emailed. The owner may share the link later.",
  "attendees": [{"email": "ada@example.com"}]
}
```

A restart drops unsent drafts. The browser response does not include a room
token or the host code.
