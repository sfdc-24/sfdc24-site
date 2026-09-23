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
    }
}
