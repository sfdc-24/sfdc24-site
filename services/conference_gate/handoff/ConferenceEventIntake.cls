/**
 * REST intake for one conference code (contract conference-event-v1).
 *
 * Claude owns this write path. Deploy this class and Event.Conference_Code__c
 * into the Omnistudio DEV org when credentials exist. This file was not
 * executed against an org. The gate POSTs the event document to
 * /services/apexrest/conference/event/v1. The conference code is an external
 * id. A repeated POST for that code updates the same Event.
 * WhoId is set when a Contact matches Email, then Name. WhatId is set from
 * Opportunity, then Account, then Campaign, and only when that id is present.
 * StartDateTime is the handoff time. EndDateTime is thirty minutes later.
 * It does not call out, and it does not read a customer org.
 */
@RestResource(urlMapping='/conference/event/v1')
global with sharing class ConferenceEventIntake {
    @HttpPost
    global static void createEvent() {
        RestResponse res = RestContext.response;
        res.addHeader('Content-Type', 'application/json');
        Object decoded;
        try {
            decoded = JSON.deserializeUntyped(RestContext.request.requestBody.toString());
        } catch (Exception ex) {
            res.statusCode = 400;
            res.responseBody = Blob.valueOf('{"ok":false,"error":"invalid_json"}');
            return;
        }
        if (!(decoded instanceof Map<String, Object>)) {
            res.statusCode = 400;
            res.responseBody = Blob.valueOf('{"ok":false,"error":"invalid_json"}');
            return;
        }
        Map<String, Object> body = (Map<String, Object>) decoded;
        if (body.get('contract') != 'conference-event-v1') {
            res.statusCode = 400;
            res.responseBody = Blob.valueOf('{"ok":false,"error":"invalid_contract"}');
            return;
        }
        String code = nonBlank(body.get('code'), null);
        Object sfRaw = body.get('salesforce');
        if (code == null || !(sfRaw instanceof Map<String, Object>)) {
            res.statusCode = 400;
            res.responseBody = Blob.valueOf('{"ok":false,"error":"invalid_payload"}');
            return;
        }
        Event row;
        try {
            row = saveByCode(code, body, (Map<String, Object>) sfRaw);
        } catch (DmlException ex) {
            res.statusCode = 400;
            res.responseBody = Blob.valueOf('{"ok":false,"error":"not_saved"}');
            return;
        }
        res.statusCode = 201;
        res.responseBody = Blob.valueOf(JSON.serialize(new Map<String, Object>{
            'ok' => true,
            'contract' => 'conference-event-v1',
            'idempotency' => 'conference_code',
            'id' => String.valueOf(row.Id),
            'code' => code
        }));
    }

    private static Event saveByCode(String code, Map<String, Object> body, Map<String, Object> sf) {
        List<Event> found = [
            SELECT Id
            FROM Event
            WHERE Conference_Code__c = :code
            LIMIT 1
        ];
        Event row = found.isEmpty() ? new Event(Conference_Code__c = code) : found[0];
        apply(row, body, sf);
        if (found.isEmpty()) {
            insert row;
        } else {
            update row;
        }
        return row;
    }

    private static void apply(Event row, Map<String, Object> body, Map<String, Object> sf) {
        String subject = nonBlank(sf.get('Subject'), 'Conference');
        row.Subject = subject.length() > 255 ? subject.substring(0, 255) : subject;
        String description = nonBlank(sf.get('Description'), null);
        if (description != null) {
            row.Description = description.length() > 32000 ? description.substring(0, 32000) : description;
        }
        row.StartDateTime = System.now();
        row.EndDateTime = row.StartDateTime.addMinutes(30);
        Id whoId = contactId(body.get('who'));
        if (whoId != null) {
            row.WhoId = whoId;
        }
        Id whatId = whatId(body.get('what'));
        if (whatId != null) {
            row.WhatId = whatId;
        }
        String hostEmail = nonBlank(sf.get('OwnerEmail'), null);
        if (hostEmail != null) {
            List<User> owners = [
                SELECT Id
                FROM User
                WHERE Email = :hostEmail AND IsActive = true
                LIMIT 1
            ];
            if (!owners.isEmpty()) {
                row.OwnerId = owners[0].Id;
            }
        }
    }

    private static Id contactId(Object whoRaw) {
        if (!(whoRaw instanceof Map<String, Object>)) {
            return null;
        }
        Map<String, Object> who = (Map<String, Object>) whoRaw;
        String email = nonBlank(who.get('Email'), null);
        if (email != null) {
            List<Contact> byEmail = [SELECT Id FROM Contact WHERE Email = :email LIMIT 1];
            if (!byEmail.isEmpty()) {
                return byEmail[0].Id;
            }
        }
        String name = nonBlank(who.get('Name'), null);
        if (name == null) {
            return null;
        }
        List<Contact> byName = [SELECT Id FROM Contact WHERE Name = :name LIMIT 1];
        return byName.isEmpty() ? null : byName[0].Id;
    }

    private static Id whatId(Object whatRaw) {
        if (!(whatRaw instanceof Map<String, Object>)) {
            return null;
        }
        Map<String, Object> what = (Map<String, Object>) whatRaw;
        for (String key : new List<String>{'OpportunityId', 'AccountId', 'CampaignId'}) {
            String text = nonBlank(what.get(key), null);
            if (text != null && Pattern.matches('^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$', text)) {
                return (Id) text;
            }
        }
        return null;
    }

    private static String nonBlank(Object value, String fallback) {
        if (value == null) {
            return fallback;
        }
        String text = String.valueOf(value).trim();
        return text == '' ? fallback : text;
    }
}
