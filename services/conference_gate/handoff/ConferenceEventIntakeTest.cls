@IsTest
private class ConferenceEventIntakeTest {
    @IsTest
    static void insertsOneEventAndUpdatesTheSameRow() {
        Contact person = new Contact(LastName = 'Lovelace', Email = 'ada@example.com');
        insert person;
        Account org = new Account(Name = 'Analytical');
        insert org;
        post('ABCD2345', 'Hear the floor once', org.Id);
        System.assertEquals(201, RestContext.response.statusCode);
        Event stored = [
            SELECT Subject, WhoId, WhatId, OwnerId, Description, Conference_Code__c
            FROM Event
            WHERE Conference_Code__c = 'ABCD2345'
        ];
        System.assertEquals('Hear the floor once', stored.Subject);
        System.assertEquals(person.Id, stored.WhoId);
        System.assertEquals(org.Id, stored.WhatId);
        System.assertEquals(UserInfo.getUserId(), stored.OwnerId);
        System.assert(stored.Description.contains('Dr. Ada'));
        System.assert(stored.Description.contains(UserInfo.getUserEmail()));
        System.assertEquals(1, [SELECT COUNT() FROM Event]);

        post('ABCD2345', 'Hear it again', null);
        System.assertEquals(1, [SELECT COUNT() FROM Event]);
        Event again = [SELECT Subject FROM Event WHERE Conference_Code__c = 'ABCD2345'];
        System.assertEquals('Hear it again', again.Subject);
    }

    @IsTest
    static void dropsARoomTokenBeforeItReachesTheEvent() {
        String payload = JSON.serialize(new Map<String, Object>{
            'contract' => 'conference-event-v1',
            'code' => 'ABCD2346',
            'salesforce' => new Map<String, Object>{
                'object' => 'Event',
                'Subject' => 'eyJhbGciOiJIUzI1NiJ9.room',
                'Description' => 'room_token=eyJhbGciOiJIUzI1NiJ9.room\n#h=handoff'
            }
        });
        RestRequest req = new RestRequest();
        req.requestUri = '/services/apexrest/conference/event/v1';
        req.httpMethod = 'POST';
        req.requestBody = Blob.valueOf(payload);
        RestContext.request = req;
        RestContext.response = new RestResponse();
        ConferenceEventIntake.createEvent();
        Event stored = [
            SELECT Subject, Description
            FROM Event
            WHERE Conference_Code__c = 'ABCD2346'
        ];
        System.assertEquals('Conference', stored.Subject);
        System.assertEquals(null, stored.Description);
    }

    private static void post(String code, String subject, Id accountId) {
        Map<String, Object> what = new Map<String, Object>();
        if (accountId != null) {
            what.put('AccountId', accountId);
        }
        String payload = JSON.serialize(new Map<String, Object>{
            'contract' => 'conference-event-v1',
            'code' => code,
            'host_email' => UserInfo.getUserEmail(),
            'agent_reference' => 'Dr. Ada',
            'who' => new Map<String, Object>{
                'object' => 'Contact',
                'Email' => 'ada@example.com',
                'Name' => 'Ada Lovelace'
            },
            'what' => what,
            'salesforce' => new Map<String, Object>{
                'object' => 'Event',
                'Subject' => subject,
                'Description' => 'Agent reference name: Dr. Ada\nHost: ' + UserInfo.getUserEmail(),
                'OwnerEmail' => UserInfo.getUserEmail()
            }
        });
        RestRequest req = new RestRequest();
        req.requestUri = '/services/apexrest/conference/event/v1';
        req.httpMethod = 'POST';
        req.requestBody = Blob.valueOf(payload);
        RestContext.request = req;
        RestContext.response = new RestResponse();
        ConferenceEventIntake.createEvent();
    }
}
