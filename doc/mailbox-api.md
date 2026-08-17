# Mailbox Tools API

The **Mailbox Tools** page at `/mailbox-tools` can create receiving aliases in
batches and issue a revocable retrieval URL for each mailbox. Aliases share the
current Cloud Mail login; they are not separate users.

The mailbox and active-URL lists support email/label/URL filtering, domain
filtering, page sizes of 10/20/50/100, selection across pages, and bulk copy or
CSV export. Bulk exports contain exactly two columns: `email` and
`retrievalUrl`; copied rows use the same fields separated by a tab.

## Retrieve verification codes and message history

Call the generated URL without a login token:

```bash
curl -sS 'https://mail.salvadawn.com/api/mailbox-tools/code/<credential>'
```

When the URL is opened directly in a browser, Cloud Mail detects the browser's
`Accept: text/html` request and renders a readable mailbox page with the
address, subject, sender, received time, verification code, and copy buttons.
The JSON API remains available for programs; append `?format=json` when a
client needs to force JSON, or send `Accept: application/json`.

```text
Browser page: https://mail.salvadawn.com/api/mailbox-tools/code/<credential>?format=html
JSON response: https://mail.salvadawn.com/api/mailbox-tools/code/<credential>?format=json
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
    "source": "stored",
    "count": 1,
    "nextAfterEmailId": 704,
    "nextBeforeEmailId": 704,
    "codeCursor": 704,
    "hasMore": false,
    "hasOlder": false,
    "hasNewer": false,
    "messages": [
      {
        "found": true,
        "email": "inbox@salvadawn.com",
        "accountId": 705,
        "code": "482731",
        "verificationCode": "482731",
        "emailId": 704,
        "from": "otp@example.net",
        "subject": "Your verification code",
        "receivedAt": "2026-08-17 12:30:00",
        "source": "stored"
      }
    ]
  }
}
```

`data.messages` contains every fetched message (up to 20 by default), not just
the newest one. Each entry includes `found`, `code`, `emailId`, subject, sender,
and receive time. `data.count` is the number returned. The legacy top-level
fields remain for clients that only need one code.

Use `limit=1..50` to control the batch size:

```bash
curl -sS 'https://mail.salvadawn.com/api/mailbox-tools/code/<credential>?limit=50'
```

When no message is available, `data.found` is `false`, both top-level code
fields are `null`, and `data.messages` is an empty array.

## Page through older history

The first cursor-less call returns the latest batch in newest-first order. If
`hasOlder` is true, pass `nextBeforeEmailId` to retrieve the next older batch:

```bash
curl -sS 'https://mail.salvadawn.com/api/mailbox-tools/code/<credential>?beforeEmailId=704&limit=20'
```

Repeat while `hasOlder` (and the generic `hasMore`) is true. The query uses a
strictly smaller ID, so adjacent pages do not overlap.

## Poll only newer mail

Pass the last processed `nextAfterEmailId` (or `latestEmailId`) as a cursor:

```bash
curl -sS 'https://mail.salvadawn.com/api/mailbox-tools/code/<credential>?afterEmailId=704'
```

The next response contains only mail with a larger ID, in oldest-first order,
and includes all messages in that batch. Array-aware consumers should save
`nextAfterEmailId` and call again until `hasNewer` (and the generic `hasMore`)
is false.

Older clients that read only the top-level `code` should save `latestEmailId`,
also exposed as `codeCursor`. On `afterEmailId` queue reads these fields advance
one matching code at a time, while `nextAfterEmailId` advances across the whole
returned batch. This prevents single-code pollers from skipping a second code
when multiple messages arrive between polls.

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
