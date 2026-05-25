# Configuration APIs

Base URL:

```txt
http://localhost:3000
```

Route prefix:

```txt
/api/configuration
```

All configuration routes require authentication and the `admin` role.

## GET `/api/configuration/case-flow`

Purpose:

- Return queues and all configured global case-flow rules.
- Rules are global for all merchants.
- Empty arrays mean cases are manual-only until configured.

Success response:

```json
{
  "queues": [
    {
      "id": "uuid",
      "name": "Documents Review",
      "slug": "documents-review",
      "prefix": "DR",
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
  ]
}
```

## PUT `/api/configuration/case-flow`

Purpose:

- Replace all case-flow rules.
- Configure first cases after merchant form submission.
- Configure cases created after a source case closes successfully.
- Configure cases that cannot close until prerequisite queues have a successfully closed case for the same merchant.

Request body:

```json
{
  "startRules": [
    {
      "targetQueueId": "uuid",
      "order": 1,
      "isActive": true
    }
  ],
  "closeTriggers": [
    {
      "sourceQueueId": "uuid",
      "targetQueueId": "uuid",
      "order": 1,
      "isActive": true
    }
  ],
  "closeBlockers": [
    {
      "blockedQueueId": "uuid",
      "prerequisiteQueueId": "uuid",
      "isActive": true
    }
  ]
}
```

Notes:

- Auto triggers always create a new case.
- Go-Live email activation continues to create the Live case through the fixed Go-Live flow.
- Queues not referenced by these rules can still be manually triggered.
