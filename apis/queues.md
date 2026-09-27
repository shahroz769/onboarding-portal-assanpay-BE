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
- **revision**: Optimistic concurrency for queue mutations.
- **stages**: Ordered persisted definitions with stable IDs. Read-only through
  the API; stages are defined and changed by developers through migrations.

## GET `/api/queues`

List queues. Default: lifecycle `active` only.

Query:

- `includeInactive=true` — include draft and inactive queues.

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
  "slaHours": 24,
  "isActive": false,
  "stages": [],
  "activation": {
    "ready": false,
    "issues": [{ "code": "stages_required", "message": "..." }]
  }
}
```

## Creating queues and changing stages

There is no API for creating queues or for creating, editing, reordering,
deactivating, or deleting stages. Developers add new queues and stage changes
through a forward-only migration in `drizzle/` (with a journal entry). A new
queue needs its `queues` row, its `queue_case_sequences` row, and its
`queue_stages`, plus any backend/frontend code its `workflowType` needs.
See `drizzle/0050_ensure_live_queue.sql` for the pattern.

## PATCH `/api/queues/:id`

Transactional update of queue fields (not stages). Requires `revision`.

- Prefix and workflow type are immutable once cases exist (409).
- Activating (`lifecycle: "active"`) runs readiness checks; incomplete defs → 422
  with `issues`, no partial write. Readiness is checked against the stored stages.
- Stale revision → 409 with current `revision`.

## PATCH `/api/queues/:id/status`

Set lifecycle (`lifecycle`) or legacy `isActive`. Optional `revision`.

## PATCH `/api/queues/:id/sla`

Update SLA hours. Optional `revision`.

## Validation rules

Activation requires the stored stage graph to have:

- exactly one active initial (`category: new`)
- at least one active terminal (`category: closed`)
- unique order and slug
- positive SLA
- case sequence present
