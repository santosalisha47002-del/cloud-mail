# Mailbox Tools API

The **Mailbox Tools** page at `/mailbox-tools` can create receiving aliases in
batches and issue a revocable retrieval URL for each mailbox. Aliases share the
current Cloud Mail login; they are not separate users.

## Retrieve the latest verification code

Call the generated URL without a login token:

```bash
curl -sS 'https://mail.salvadawn.com/api/mailbox-tools/code/<credential>'
```

Response:

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "found": true,
    "email": "inbox@salvadawn.com",
    "accountId": 705,
    "code": "482731",
    "verificationCode": "482731",
    "emailId": 704,
    "latestEmailId": 704,
    "from": "otp@example.net",
    "subject": "Your verification code",
    "receivedAt": "2026-08-17 12:30:00",
    "source": "stored"
  }
}
```

When no matching message is available, `data.found` is `false` and both code
fields are `null`.

## Poll only newer mail

Pass the last processed `latestEmailId` as a cursor:

```bash
curl -sS 'https://mail.salvadawn.com/api/mailbox-tools/code/<credential>?afterEmailId=704'
```

The next response contains only mail with a larger ID. Save the returned
`latestEmailId` for the following call.

## Authenticated management endpoints

Cloud Mail uses the raw login JWT in the `Authorization` header (without a
`Bearer` prefix).

```text
POST   /api/mailbox-tools/batch-create
GET    /api/mailbox-tools/tokens
POST   /api/mailbox-tools/tokens
GET    /api/mailbox-tools/tokens/:tokenId/test
DELETE /api/mailbox-tools/tokens/:tokenId
```

Batch body example:

```json
{"count":10,"domain":"salvadawn.com","prefix":"api","length":10}
```

Every newly created mailbox receives its own independent credential in the
same response:

```json
{
  "created": [
    {
      "accountId": 706,
      "email": "api7m2k9p4x@salvadawn.com",
      "tokenId": 3,
      "token": "<mailbox-specific-credential>",
      "codeUrl": "https://mail.salvadawn.com/api/mailbox-tools/code/<mailbox-specific-credential>"
    }
  ]
}
```

Credentials are not shared between addresses. Revoking one mailbox URL does
not affect the URLs belonging to the other mailboxes.

Token body example:

```json
{"accountId":705,"label":"inbox automation"}
```

Deleting a token immediately invalidates its retrieval URL. The URL itself is
a mailbox-scoped credential and should be stored like an API key.
