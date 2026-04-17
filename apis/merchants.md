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
- `bankName` must match the approved bank-name list configured in the backend

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
- `500` storage env not configured
- `502` Google Drive upload/create failure
