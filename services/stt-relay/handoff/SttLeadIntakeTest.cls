@IsTest
private class SttLeadIntakeTest {
    @IsTest
    static void insertsALeadFromTheStreamContract() {
        String payload = JSON.serialize(new Map<String, Object>{
            'contract' => 'stt-lead-v1',
            'session_id' => 'sess-lovelace',
            'salesforce' => new Map<String, Object>{
                'LastName' => 'Lovelace',
                'Company' => 'Analytical',
                'Email' => 'ada@example.com',
                'Phone' => '4165550199',
                'LeadSource' => 'www.sfdc24.com/stream',
                'Description' => 'Said: call back about automation'
            }
        });
        RestRequest req = new RestRequest();
        req.requestUri = '/services/apexrest/stt/lead/v1';
        req.httpMethod = 'POST';
        req.requestBody = Blob.valueOf(payload);
        RestContext.request = req;
        RestContext.response = new RestResponse();

        Test.startTest();
        SttLeadIntake.createLead();
        Test.stopTest();

        System.assertEquals(201, RestContext.response.statusCode);
        Lead stored = [SELECT LastName, Company, Email, Phone, LeadSource FROM Lead LIMIT 1];
        System.assertEquals('Lovelace', stored.LastName);
        System.assertEquals('Analytical', stored.Company);
        System.assertEquals('ada@example.com', stored.Email);
        System.assertEquals('4165550199', stored.Phone);
        System.assertEquals('www.sfdc24.com/stream', stored.LeadSource);
        System.assertEquals(1, [SELECT COUNT() FROM Lead]);
    }

    @IsTest
    static void blankOptionalContactFieldsStillInsert() {
        String payload = JSON.serialize(new Map<String, Object>{
            'contract' => 'stt-lead-v1',
            'session_id' => 'sess-blank',
            'salesforce' => new Map<String, Object>{
                'LastName' => 'Lovelace',
                'Company' => 'Analytical',
                'Email' => '',
                'Phone' => '',
                'Description' => 'Said: call back'
            }
        });
        post(payload);
        System.assertEquals(201, RestContext.response.statusCode);
        Lead stored = [SELECT Email, Phone FROM Lead LIMIT 1];
        System.assertEquals(null, stored.Email);
        System.assertEquals(null, stored.Phone);
    }

    @IsTest
    static void theSameSessionUpsertsOneLeadAndKeepsALaterPhone() {
        post(sessionPayload('sess-one', 'Lovelace', 'Analytical', '', ''));
        System.assertEquals(201, RestContext.response.statusCode);
        post(sessionPayload('sess-one', 'Lovelace', 'Analytical', '', '4165550199'));
        System.assertEquals(201, RestContext.response.statusCode);
        System.assertEquals(1, [SELECT COUNT() FROM Lead]);
        Lead stored = [SELECT Phone, Stt_Session_Id__c FROM Lead LIMIT 1];
        System.assertEquals('4165550199', stored.Phone);
        System.assertEquals('sess-one', stored.Stt_Session_Id__c);
        Map<String, Object> ack = (Map<String, Object>) JSON.deserializeUntyped(
            RestContext.response.responseBody.toString()
        );
        System.assertEquals(true, ack.get('ok'));
        System.assertEquals('session_id', ack.get('idempotency'));
        System.assertEquals(stored.Id, ack.get('id'));
        System.assertEquals('sess-one', ack.get('session_id'));
    }

    @IsTest
    static void twoSessionsAreTwoLeads() {
        post(sessionPayload('sess-a', 'Lovelace', 'Analytical', '', ''));
        post(sessionPayload('sess-b', 'Hopper', 'Navy', '', ''));
        System.assertEquals(2, [SELECT COUNT() FROM Lead]);
    }

    @IsTest
    static void missingSessionDoesNotInsert() {
        post('{"contract":"stt-lead-v1","salesforce":{"LastName":"Lovelace","Company":"Analytical"}}');
        System.assertEquals(400, RestContext.response.statusCode);
        System.assertEquals(0, [SELECT COUNT() FROM Lead]);
    }

    @IsTest
    static void nullJsonDoesNotInsert() {
        post('null');
        System.assertEquals(400, RestContext.response.statusCode);
        System.assertEquals(0, [SELECT COUNT() FROM Lead]);
    }

    @IsTest
    static void emptyObjectDoesNotInsert() {
        post('{}');
        System.assertEquals(400, RestContext.response.statusCode);
        System.assertEquals(0, [SELECT COUNT() FROM Lead]);
    }

    @IsTest
    static void wrongContractDoesNotInsert() {
        post('{"contract":"other","salesforce":{"LastName":"Lovelace"}}');
        System.assertEquals(400, RestContext.response.statusCode);
        System.assertEquals(0, [SELECT COUNT() FROM Lead]);
    }

    @IsTest
    static void nonObjectSalesforceDoesNotInsert() {
        post('{"contract":"stt-lead-v1","salesforce":"nope"}');
        System.assertEquals(400, RestContext.response.statusCode);
        System.assertEquals(0, [SELECT COUNT() FROM Lead]);
        post('{"contract":"stt-lead-v1","salesforce":["LastName"]}');
        System.assertEquals(400, RestContext.response.statusCode);
        System.assertEquals(0, [SELECT COUNT() FROM Lead]);
    }

    private static String sessionPayload(String sessionId, String lastName, String company, String email, String phone) {
        return JSON.serialize(new Map<String, Object>{
            'contract' => 'stt-lead-v1',
            'session_id' => sessionId,
            'salesforce' => new Map<String, Object>{
                'LastName' => lastName,
                'Company' => company,
                'Email' => email,
                'Phone' => phone,
                'Description' => 'Said: call back'
            }
        });
    }

    private static void post(String payload) {
        RestRequest req = new RestRequest();
        req.requestUri = '/services/apexrest/stt/lead/v1';
        req.httpMethod = 'POST';
        req.requestBody = Blob.valueOf(payload);
        RestContext.request = req;
        RestContext.response = new RestResponse();
        SttLeadIntake.createLead();
    }
}
