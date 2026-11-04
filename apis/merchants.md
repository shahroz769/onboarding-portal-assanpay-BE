# Merchant APIs

Base URL:

```txt
http://localhost:3000
```

Route prefix:

```txt
/api/public
```

## POST `/api/public/merchant-form`

Purpose:

- Create a merchant onboarding submission
- Upload merchant documents to Google Drive
- Store only Google Drive metadata and links in the database

Request content type:

```txt
multipart/form-data
```

Scalar form fields:

- `email`
- `ownerFullName`
- `ownerPhone`
- `businessName`
- `businessPhone`
- `businessEmail`
- `businessAddress`
- `businessWebsite`
- `websiteCms`
- `businessDescription`
- `businessRegistrationDate`
- `businessNature`
- `merchantType`
- `estimatedMonthlyTransactions`
- `estimatedMonthlyVolume`
- `accountTitle`
- `bankName`
- `branchName`
- `accountNumberIban`
- `swiftCode` optional
- `nextOfKinRelation`

File field names:

- `owner_cnic_front`
- `owner_cnic_back`
- `next_of_kin_cnic_front`
- `next_of_kin_cnic_back`
- `utility_bill`
- Merchant-type-specific fields:
  `company_ntn`, `authority_letter`, `taxpayer_registration_certificate`,
  `company_incorporation_certificate`, `memorandum_articles`, `form_ii`,
  `form_a`, `board_resolution`, `certificate_of_commencement`,
  `partnership_deed`, `form_c`, `llp_form_iii`, `annual_audited_accounts`,
  `other_entity_certification`, `secp_section_42_license`,
  `risk_assessment_documents`, `by_laws_rules_regulations`

Validation rules:

- Max file size: `10 MB`
- Allowed file formats: `PDF`, `JPG`, `JPEG`, `PNG`, `WEBP`
- Required file fields depend on `merchantType`
- `utility_bill` is required for every submission
- `bankName` must match the approved bank-name list configured in the backend
- Min file size: `500 bytes`; file name at most `255` characters, with an allowed
  extension that agrees with the declared file type
- Text fields have maximum lengths matching their database columns
- `email` and `businessEmail` must not use a reserved domain (`example.com`,
  `.example`, `.test`, `.invalid`, `.localhost`)
- `businessWebsite` must be a public `http` or `https` URL, at most `500`
  characters, and not a private address or reserved domain

Limits and logging:

- Each IP may create `PUBLIC_SUBMISSION_LIMIT_PER_IP` merchants (default `3`) in
  a rolling 24 hours. Rejected attempts do not count, and retrying an accepted
  `Idempotency-Key` still returns its merchant.
- Every attempt that reaches this route is stored in
  `public_submission_attempts` with its IP, user agent, outcome and status for
  60 days.

Success response:

- Status: `201`

```json
{
  "merchant": {
    "id": "uuid",
    "status": "form_submitted",
    "onboardingStage": "form_submitted"
  },
  "documents": [
    {
      "id": "uuid",
      "documentType": "owner_cnic_front",
      "googleDriveFileId": "drive-file-id",
      "googleDriveWebViewLink": "https://...",
      "googleDriveDownloadLink": "https://..."
    }
  ]
}
```

Error responses:

- `400` invalid payload or missing required fields/documents
- `413` file exceeds size limit
- `415` unsupported file type
- `429` per-IP submission limit reached
- `500` storage env not configured
- `502` Google Drive upload/create failure

## PATCH `/api/merchants/:id/terminate`

Access: authenticated `super_admin` or `admin`. Only `super_admin` may send
`deleteDriveFiles: true`; otherwise the request is rejected with `403` before
anything changes.

Request body:

```json
{
  "reason": "Spam",
  "deleteDriveFiles": false
}
```

Termination commits first. `driveFiles` is `null` when deletion was not
requested, and a Drive failure does not undo the termination:

```json
{
  "id": "uuid",
  "status": "terminated",
  "closedCaseCount": 1,
  "driveFiles": { "status": "deleted", "deletedStorageObjectCount": 12 }
}
```

On failure, `driveFiles` is `{ "status": "failed", "message": "..." }`; retry
with `DELETE /api/merchants/:id/drive-files`.

## POST `/api/merchants/bulk-terminate`

Takes `ids` (up to 100), `reason` and `deleteDriveFiles`, with the same access
rule. Drive files are deleted in the background after the response;
`driveFilesQueuedCount` reports how many merchants were queued. A merchant whose
deletion fails keeps a null `driveFilesDeletedAt`, so it can be retried.

## DELETE `/api/merchants/:id/drive-files`

Purpose:

- Move a terminated merchant's Google Drive files and folders to the Drive trash
- Keep the merchant, its cases and its document records

Access: authenticated `super_admin` only.

Files are never hard-deleted: they go to the Drive trash, which Google empties
after 30 days. Until then they can be restored in Drive, but not from the portal.
The same ownership ledger checks as permanent delete apply.

Success response:

```json
{
  "id": "uuid",
  "deletedStorageObjectCount": 12,
  "driveFilesDeletedAt": "2026-11-04T10:00:00.000Z"
}
```

Errors:

- `404` merchant not found
- `409` merchant is not terminated, its files are already deleted, or Drive
  ownership is incomplete
- `502` Google Drive failure; safe to retry

## DELETE `/api/merchants/:id/permanent`

Purpose:

- Permanently delete a merchant and all merchant/case records
- Move all Google Drive objects explicitly owned by that merchant to the Drive
  trash, which Google empties after 30 days

Access: authenticated `super_admin` only.

Request body:

```json
{
  "confirmation": "Exact Merchant Business Name"
}
```

The confirmation must exactly match the merchant business name. Drive cleanup
is restricted to objects in the storage ownership ledger; deletion is rejected
if a merchant root folder or linked merchant/case file is not represented there.

Success response:

```json
{
  "id": "uuid",
  "deletedStorageObjectCount": 12
}
```
