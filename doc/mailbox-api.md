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
GET    /api/mailbox-tools/mailboxes
POST   /api/mailbox-tools/mailboxes/ensure-tokens
GET    /api/mailbox-tools/mailboxes/:accountId/messages
GET    /api/mailbox-tools/tokens
POST   /api/mailbox-tools/tokens
GET    /api/mailbox-tools/tokens/:tokenId/test
DELETE /api/mailbox-tools/tokens/:tokenId
```

The **邮箱管理 / Mailbox Management** page is available from the left menu at
`/mailbox-management`. It is an owner-scoped inventory of every active mailbox,
not just mailboxes that already have a retrieval token. It supports server-side
search, domain and API-status filters, page sizes of 10/20/50/100, selection
across pages, bulk copy/export, one-click creation of missing retrieval URLs,
and a mailbox drawer that shows received-message history.

List mailboxes with server-side pagination:

```text
GET /api/mailbox-tools/mailboxes?page=1&pageSize=20&keyword=&domain=&tokenStatus=all
```

`tokenStatus` is `all`, `active`, or `missing`. The response contains `list`,
`total`, `pageCount`, global `stats`, and each mailbox's canonical newest active
`primaryToken`/`codeUrl`. A mailbox with multiple active credentials is returned
once; `tokenCount` reports the total active credentials.

Create a URL for selected mailboxes that currently have none (the operation is
idempotent and accepts at most 100 IDs per request):

```http
POST /api/mailbox-tools/mailboxes/ensure-tokens
Content-Type: application/json

{"accountIds":[707,758]}
```

Read one mailbox's received history without requiring a retrieval URL:

```text
GET /api/mailbox-tools/mailboxes/707/messages?limit=20
GET /api/mailbox-tools/mailboxes/707/messages?beforeEmailId=706&limit=20
GET /api/mailbox-tools/mailboxes/707/messages?afterEmailId=706&limit=20
```

The message endpoint always checks both the signed-in owner and the active
mailbox row. It returns bounded plain-text previews, subjects, senders, times,
and extracted verification codes; raw HTML is not rendered by the management
page.

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
