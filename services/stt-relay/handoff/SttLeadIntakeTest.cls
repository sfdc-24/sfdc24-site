@IsTest
private class SttLeadIntakeTest {
    @IsTest
    static void insertsALeadFromTheStreamContract() {
        String payload = JSON.serialize(new Map<String, Object>{
            'contract' => 'stt-lead-v1',
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
