# Configuration APIs

Base URL:

```txt
http://localhost:3000
```

Route prefix:

```txt
/api/configuration
```

All configuration routes require authentication. Case-flow routes require the
`super_admin` role.

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

- Auto triggers always create a new case.
- Go-Live email activation continues to create the Live case through the fixed
  Go-Live flow.
- Queues not referenced by these rules can still be manually triggered.
