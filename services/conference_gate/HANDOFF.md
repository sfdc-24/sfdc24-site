# Conference flow

## Guest join

The conference room is not inside Salesforce. `https://portal.sfdc24.com/` is the gate only.

1. The guest opens the portal. This website does not host that form.
2. The guest enters the Conference Code and either a last name or an email.
3. The portal posts that pair to `POST /v1/enter`. One human joiner per code. A second joiner is rejected. A mismatch does not spend the code.
4. On a match the gate mints the LiveKit JWT and returns `room_path` (`/conference/room/#h=` plus a one-time handoff). The response does not include the JWT.
5. The portal navigates the top window to `https://www.sfdc24.com` plus `room_path`. It does not embed the room in an Experience Cloud iframe. WebRTC stays on the LiveKit page so the call keeps full bandwidth.
6. `/conference/room/` reads the handoff, asks for the microphone, then posts `POST /v1/room` once. That response carries the short-lived token. The hash is removed. Official LiveKit Meet can replace this page later. Until then this is the thin client.
7. Host create stays on `/conference/create/`. The host code is resolved on the server and is not published here.
8. `https://www.sfdc24.com/conference/` is a secondary status surface. It is not the room.

Experience Cloud owns the gate screen. Claude owns that org surface if it still needs to be built. This repository does not put the media path inside Salesforce.

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
reference name, the portal gate `https://portal.sfdc24.com/`, the LiveKit
room `https://www.sfdc24.com/conference/room/`, and the conference code. Those
links are stable. The one-time room handoff is created only at `POST
/v1/enter`. The draft has no clock time.

The shapes below are the contract for a later sender. This process does not
POST them.

## Gmail body

```json
{
  "to": "ada@example.com",
  "subject": "Hear the floor once",
  "body": "Agent reference name: Dr. Ada\nPortal gate: https://portal.sfdc24.com/\nLiveKit room: https://www.sfdc24.com/conference/room/\nConference code: ABCD2345\nEnter the code and a last name or an email at the portal. The room opens on the LiveKit page."
}
```

## Calendar body

```json
{
  "summary": "Hear the floor once",
  "description": "Agent reference name: Dr. Ada\nPortal gate: https://portal.sfdc24.com/\nLiveKit room: https://www.sfdc24.com/conference/room/\nConference code: ABCD2345\nEnter the code and a last name or an email at the portal. The room opens on the LiveKit page.",
  "attendees": [{"email": "ada@example.com"}]
}
```

A restart drops unsent drafts. The browser response does not include a room
token or the host code.
