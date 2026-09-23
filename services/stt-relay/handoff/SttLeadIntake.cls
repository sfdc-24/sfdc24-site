/**
 * REST intake for the public 3-minute stream (contract stt-lead-v1).
 *
 * Deploy into the Omnistudio DEV org when credentials exist.
 * The relay POSTs the full lead document to /services/apexrest/stt/lead/v1.
 * This class inserts a Lead. A second POST inserts another Lead; it does not
 * upsert. It does not call out, and it does not read a customer org.
 */
@RestResource(urlMapping='/stt/lead/v1')
global with sharing class SttLeadIntake {
    @HttpPost
    global static void createLead() {
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
        if (body.get('contract') != 'stt-lead-v1') {
            res.statusCode = 400;
            res.responseBody = Blob.valueOf('{"ok":false,"error":"invalid_contract"}');
            return;
        }
        Object sfRaw = body.get('salesforce');
        if (!(sfRaw instanceof Map<String, Object>)) {
            res.statusCode = 400;
            res.responseBody = Blob.valueOf('{"ok":false,"error":"invalid_payload"}');
            return;
        }
        Map<String, Object> sf = (Map<String, Object>) sfRaw;

        Lead row = new Lead();
        row.LastName = nonBlank(sf.get('LastName'), 'Callback');
        row.Company = nonBlank(sf.get('Company'), 'Unknown');
        String email = nonBlank(sf.get('Email'), null);
        if (email != null && email.contains('@')) row.Email = email;
        String phone = nonBlank(sf.get('Phone'), null);
        if (phone != null) row.Phone = phone;
        row.LeadSource = nonBlank(sf.get('LeadSource'), 'www.sfdc24.com/stream');
        String description = nonBlank(sf.get('Description'), '');
        if (description != null && description.length() > 32000) {
            description = description.substring(0, 32000);
        }
        row.Description = description == null ? '' : description;
        insert row;

        res.statusCode = 201;
        res.responseBody = Blob.valueOf(JSON.serialize(new Map<String, Object>{
            'ok' => true,
            'contract' => 'stt-lead-v1',
            'id' => String.valueOf(row.Id),
            'session_id' => body.get('session_id')
        }));
    }

    private static String nonBlank(Object value, String fallback) {
        if (value == null) return fallback;
        String text = String.valueOf(value).trim();
        return String.isBlank(text) ? fallback : text;
    }
}
