# Configuration APIs

Base URL:

```txt
http://localhost:3000
```

Route prefix:

```txt
/api/configuration
```

All configuration routes require authentication. Configuration management
routes allow the `super_admin` and `admin` roles.

## GET `/api/configuration/case-flow`

Purpose:

- Return the current flow-configuration revision, queues, and all configured
  global case-flow rules (including inactive rules).
- Rules are global for all merchants.
- Empty arrays mean cases are manual-only until configured.

Success response:

```json
{
  "revision": 1,
  "queues": [
    {
      "id": "uuid",
      "name": "Documents Review",
      "slug": "documents-review",
      "prefix": "DR",
      "workflowType": "document_review",
      "lifecycle": "active",
      "isActive": true
    }
  ],
  "startRules": [
    {
      "id": "uuid",
      "targetQueueId": "uuid",
      "order": 1,
      "isActive": true
    }
  ],
  "closeTriggers": [
    {
      "id": "uuid",
      "sourceQueueId": "uuid",
      "targetQueueId": "uuid",
      "order": 1,
      "isActive": true
    }
  ],
  "closeBlockers": [
    {
      "id": "uuid",
      "blockedQueueId": "uuid",
      "prerequisiteQueueId": "uuid",
      "isActive": true
    }
  ],
  "creationRequirements": [
    {
      "id": "uuid",
      "targetQueueId": "uuid",
      "prerequisiteQueueId": "uuid",
      "isActive": true
    }
  ]
}
```

## PUT `/api/configuration/case-flow`

Purpose:

- Create, update, and deactivate case-flow rules in one revisioned transaction.
- Configure first cases after merchant form submission.
- Configure cases created after a source case closes successfully.
- Configure cases that cannot close until prerequisite queues have a
  successfully closed case for the same merchant.
- Configure cases that cannot be created until prerequisite queues have a
  successfully closed case for the same merchant.

Request body:

```json
{
  "revision": 1,
  "startRules": [
    {
      "id": "uuid",
      "targetQueueId": "uuid",
      "order": 1,
      "isActive": true
    }
  ],
  "closeTriggers": [
    {
      "id": "uuid",
      "sourceQueueId": "uuid",
      "targetQueueId": "uuid",
      "order": 1,
      "isActive": true
    }
  ],
  "closeBlockers": [
    {
      "id": "uuid",
      "blockedQueueId": "uuid",
      "prerequisiteQueueId": "uuid",
      "isActive": true
    }
  ],
  "creationRequirements": [
    {
      "id": "uuid",
      "targetQueueId": "uuid",
      "prerequisiteQueueId": "uuid",
      "isActive": true
    }
  ]
}
```

Behavior:

- `revision` is required and must match the current server revision.
- Rules with `id` are updated in place.
- Rules without `id` are inserted.
- Existing rules missing from the payload are deactivated (`isActive: false`),
  not hard-deleted.
- Active graphs are validated before commit: no cycles in creation requirements
  or close blockers, no duplicate active edges, no impossible
  trigger/requirement combinations, no inactive queue targets, and no targets
  without usable initial/terminal stages.
- Validation errors name queue IDs/names and cycle paths. They never include SQL
  details.

Conflict response (`409`):

```json
{
  "error": "Case flow configuration was updated by someone else. Reload and try again.",
  "revision": 2
}
```

Clients must reload the current configuration and retry with the returned
revision. Do not overwrite a stale revision.

Notes:

- Auto close triggers skip their target when that case already exists.
- A successfully closed Agreement case creates the Live case automatically.
- Merchants are not sent a Go-Live link and do not request Live activation.
- Queues not referenced by these rules can still be manually triggered.

## GET `/api/configuration/email-recipients`

Purpose:

- Extra recipients on case emails sent through Resend (agreement,
  resubmission request, portal credentials, live activation). Staff password
  emails are not affected.

Authorization: `super_admin`, `admin`

Success response: `200`

```json
{
  "ccSender": true,
  "ccOtherMerchantEmail": true,
  "cc": ["ops@example.com"],
  "bcc": ["archive@example.com"],
  "replyTo": []
}
```

- `ccSender`: CC the portal user who sends the email.
- `ccOtherMerchantEmail`: CC the merchant's other address (sending to the
  business email copies the submitter email, and the other way round).
- `cc` / `bcc`: up to 20 addresses each; `replyTo`: up to 5 (empty uses
  `EMAIL_REPLY_TO`). Duplicates and the recipient itself are dropped when
  sending. With `EMAIL_TEST_TO` set, CC and BCC are dropped (kept in the
  email log metadata) so test sends only reach the test inbox.
- Manual (Gmail) email previews return the same `cc`, `bcc` and `replyTo`.

## PUT `/api/configuration/email-recipients`

Authorization: `super_admin`, `admin`

Request body: the object above. Addresses are trimmed and lower-cased; each
list rejects invalid, over-long (more than 254 characters) or repeated addresses, and
an address can't be in both `cc` and `bcc` (`400`). Returns the saved object.
