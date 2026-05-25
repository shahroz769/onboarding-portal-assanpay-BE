# Case APIs

Base URL:

```txt
http://localhost:3000
```

Route prefix:

```txt
/api/cases
```

All case routes require authentication.

## POST `/api/cases`

Purpose:

- Manually create a case for an existing merchant in an existing queue.
- Merchant submission and successful case closure can create follow-up cases when admin case-flow rules are configured.

Authorization:

- `admin`
- `supervisor`

Request body:

```json
{
  "merchantId": "uuid",
  "queueId": "uuid"
}
```

Success response:

- Status: `201`

```json
{
  "id": "uuid",
  "caseNumber": "DR-000000001",
  "queueId": "uuid",
  "queueName": "Documents Review",
  "merchantId": "uuid",
  "merchantName": "Merchant Name",
  "ownerId": null,
  "ownerName": null,
  "status": "new",
  "priority": "normal",
  "closedAt": null,
  "createdAt": "2026-05-02T00:00:00.000Z",
  "updatedAt": "2026-05-02T00:00:00.000Z"
}
```

Error responses:

- `400` invalid payload
- `401` missing or invalid authentication
- `403` authenticated user is not an admin or supervisor
- `404` merchant or queue not found
- `500` queue stage or case number generation failure
