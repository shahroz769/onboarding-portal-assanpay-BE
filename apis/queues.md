# Queues APIs

Base URL:

```txt
http://localhost:3000
```

Route prefix:

```txt
/api/queues
```

All routes require authentication. Mutations require `super_admin`.

## Concepts

- **Slug**: URL/business identifier only. Not used for behavior dispatch.
- **workflowType**: Stable behavior key (`generic`, `document_review`, `agreement`,
  `mid`, `testing`, `wordpress`, `card`, `live`,
  `sub_merchant_form`).
- **lifecycle**: `draft` | `active` | `inactive`. API boundary uses lifecycle;
  DB `is_active` remains synced (`active` ↔ true).
- **revision**: Optimistic concurrency for queue/stage mutations.
- **stages**: Ordered persisted definitions with stable IDs. Referenced stages
  may be renamed/deactivated but never hard-deleted while cases reference them.

## GET `/api/queues`

List queues. Default: lifecycle `active` only.

Query:

- `includeInactive=true` — include draft and inactive queues.

## GET `/api/queues/templates`

Return named stage templates used when creating queues.

## GET `/api/queues/:id`

Queue detail including stages and activation readiness:

```json
{
  "id": "uuid",
  "name": "Support",
  "slug": "support",
  "prefix": "SP",
  "workflowType": "generic",
  "lifecycle": "draft",
  "revision": 1,
  "qcEnabled": false,
  "slaHours": 24,
  "isActive": false,
  "stages": [],
  "activation": {
    "ready": false,
    "issues": [{ "code": "stages_required", "message": "..." }]
  }
}
```

## POST `/api/queues`

Create a draft/inactive queue with a complete stage definition or named template.

Body:

```json
{
  "name": "Support",
  "slug": "support",
  "prefix": "SP",
  "workflowType": "generic",
  "lifecycle": "draft",
  "slaHours": 24,
  "stageTemplate": "generic"
}
```

Notes:

- Creating with `lifecycle: "active"` is rejected; activate after readiness checks.
- Unknown workflows still receive stages (template for `workflowType`).
- Response includes persisted stages.

## PATCH `/api/queues/:id`

Transactional update. Requires `revision`.

- Prefix and workflow type are immutable once cases exist (409).
- Activating (`lifecycle: "active"`) runs readiness checks; incomplete defs → 422
  with `issues`, no partial write.
- Stale revision → 409 with current `revision`.

## PATCH `/api/queues/:id/status`

Set lifecycle (`lifecycle`) or legacy `isActive`. Optional `revision`.

## PATCH `/api/queues/:id/sla`

Update SLA hours. Optional `revision`.

## Stage endpoints

- `POST /api/queues/:id/stages` — create stage (`revision` required)
- `PATCH /api/queues/:id/stages/:stageId` — update stage
- `POST /api/queues/:id/stages/:stageId/deactivate` — deactivate
- `DELETE /api/queues/:id/stages/:stageId` — hard-delete only when unreferenced;
  referenced stages → 409 (deactivate instead)
- `PATCH /api/queues/:id/stages/reorder` — `{ revision, stageIds: uuid[] }`

## Validation rules

Active stage graph must have:

- exactly one active initial (`category: new`)
- at least one active terminal (`category: closed`)
- unique order and slug
- positive SLA
- case sequence present
