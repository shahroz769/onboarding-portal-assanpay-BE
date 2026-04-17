# Merchant Onboarding Form Guide For Frontend

This guide describes the merchant onboarding form exactly as the backend expects it today.

## Endpoint

- Method: `POST`
- URL: `/api/public/merchant-form`
- Content-Type: `multipart/form-data`

Important:
- The request must be sent as `multipart/form-data`.
- All text fields must be sent as single text values.
- File inputs must use the exact backend document field names.
- Unknown text fields or unknown file fields will be rejected.
- A scalar field cannot be sent more than once.
- A document field cannot be uploaded more than once.

## Submission Shape

The payload contains:
- Text fields for merchant details
- File fields for documents

The backend stores:
- `email` input as `submitterEmail`
- All other field names mostly map directly

## Form Sections

Recommended frontend sections:
1. Submitter Information
2. Owner Information
3. Business Information
4. Business Classification
5. Financial Information
6. Next Of Kin
7. Documents

## Text Fields

### 1. Submitter Information

| Field Name | Suggested Label | Type | Required | Validation | Notes |
|---|---|---|---|---|---|
| `email` | Submitter Email | email | Yes | Must be a valid email address | Lowercased by backend |

### 2. Owner Information

| Field Name | Suggested Label | Type | Required | Validation | Notes |
|---|---|---|---|---|---|
| `ownerFullName` | Owner Full Name | text | Yes | Trimmed, required, sanitized, cannot be empty | Use plain text input |
| `ownerPhone` | Owner Phone Number | text | Yes | Trimmed, required, cannot be empty | No backend regex currently enforced |

### 3. Business Information

| Field Name | Suggested Label | Type | Required | Validation | Notes |
|---|---|---|---|---|---|
| `businessName` | Business Name | text | Yes | Trimmed, required, sanitized, cannot be empty | |
| `businessPhone` | Business Phone Number | text | Yes | Trimmed, required, cannot be empty | No backend regex currently enforced |
| `businessEmail` | Business Email | email | Yes | Must be a valid email address | Lowercased by backend |
| `businessAddress` | Business Address | textarea | Yes | Trimmed, required, sanitized, cannot be empty | |
| `businessWebsite` | Business Website | url | Yes | Must be a valid URL | Include protocol like `https://` |
| `websiteCms` | Website Platform / CMS | select | Yes | Must match allowed enum | Options listed below |
| `businessDescription` | Business Description | textarea | Yes | Trimmed, required, sanitized, cannot be empty | |
| `businessRegistrationDate` | Business Registration Date | date | Yes | Must be a valid date and cannot be in the future | Backend stores as `YYYY-MM-DD` |
| `businessNature` | Nature Of Business | text | Yes | Trimmed, required, sanitized, cannot be empty | |

### 4. Business Classification

| Field Name | Suggested Label | Type | Required | Validation | Notes |
|---|---|---|---|---|---|
| `merchantType` | Merchant Type | select | Yes | Must match allowed enum | Controls document requirements |
| `estimatedMonthlyTransactions` | Estimated Monthly Transactions | number | Yes | Must be a whole number greater than 0 | Send as numeric string in form-data |
| `estimatedMonthlyVolume` | Estimated Monthly Volume | number / currency | Yes | Must be greater than 0 | Backend stores with 2 decimals |

### 5. Financial Information

| Field Name | Suggested Label | Type | Required | Validation | Notes |
|---|---|---|---|---|---|
| `accountTitle` | Account Title | text | Yes | Trimmed, required, sanitized, cannot be empty | |
| `bankName` | Bank Name | select | Yes | Must match allowed enum | Options listed below |
| `branchName` | Branch Name | text | Yes | Trimmed, required, sanitized, cannot be empty | |
| `accountNumberIban` | Account Number / IBAN | text | Yes | Trimmed, required, cannot be empty | No backend pattern currently enforced |
| `swiftCode` | SWIFT Code | text | No | Trimmed, optional | Empty string becomes `null` |

### 6. Next Of Kin

| Field Name | Suggested Label | Type | Required | Validation | Notes |
|---|---|---|---|---|---|
| `nextOfKinRelation` | Next Of Kin Relation | select | Yes | Must match allowed enum | Options listed below |

## Allowed Select Options

### websiteCms

| Value | Suggested Label |
|---|---|
| `wordpress` | WordPress |
| `shopify` | Shopify |
| `custom_website` | Custom Website |

### merchantType

| Value | Suggested Label |
|---|---|
| `sole_proprietorship` | Sole Proprietorship |
| `private_limited_company` | Private Limited Company |
| `partnership` | Partnership |
| `limited_liability_partnership` | Limited Liability Partnership |
| `ngo_npo_charity` | NGO / NPO / Charity |
| `trust_society_association` | Trust / Society / Association |

### nextOfKinRelation

| Value | Suggested Label |
|---|---|
| `mother` | Mother |
| `father` | Father |
| `brother` | Brother |
| `sister` | Sister |
| `wife` | Wife |
| `son` | Son |
| `daughter` | Daughter |

### bankName

Use these exact values:

- `Advans Microfinance Bank`
- `Al Baraka Islamic Bank Limited`
- `Bank AlFalah Limited`
- `Allied Bank Limited`
- `Apna Microfinance Bank`
- `Askari Commercial Bank Limited`
- `Bank of Khyber`
- `Bank Islami Pakistan Limited`
- `Burj Bank Limited`
- `Citi Bank`
- `Dubai Islamic Bank Pakistan Limited`
- `FINCA`
- `Finja`
- `First Women Bank`
- `Faysal Bank Limited`
- `Habib Bank Limited`
- `Habib Metropolitan Bank`
- `ICBC`
- `JS Bank`
- `KASB Bank`
- `MCB Bank Limited`
- `MCB Arif Habib`
- `MCB Islamic Bank`
- `Meezan Bank`
- `Mobilink Microfinance Bank`
- `NayaPay`
- `National Bank of Pakistan`
- `NIB Bank`
- `NRSP Bank Fori Cash`
- `Paymax`
- `Sadapay`
- `Standard Chartered Bank`
- `Samba Bank`
- `Silkbank`
- `Sindh Bank`
- `Soneri Bank Limited`
- `Summit Bank`
- `TAG`
- `United Bank Limited`
- `Upaisa`
- `ZTBL`
- `EasyPaisa`
- `JazzCash`

## File Upload Rules

### General Rules

- At least one document file must be uploaded.
- Each document field can only contain one file.
- Max file size per file: `10 MB`
- Total number of uploaded files cannot exceed the number of supported document types.
- Allowed mime types:
  - `application/pdf`
  - `image/jpeg`
  - `image/png`
  - `image/webp`
- Allowed file extensions:
  - `.pdf`
  - `.jpg`
  - `.jpeg`
  - `.png`
  - `.webp`
- If a file has size `0`, backend ignores it.
- File field names must exactly match the document type values below.

### Base Documents Required For All Merchant Types

| Field Name | Suggested Label | Required |
|---|---|---|
| `owner_cnic_front` | Owner CNIC Front | Yes |
| `owner_cnic_back` | Owner CNIC Back | Yes |
| `next_of_kin_cnic_front` | Next Of Kin CNIC Front | Yes |
| `next_of_kin_cnic_back` | Next Of Kin CNIC Back | Yes |
| `utility_bill` | Utility Bill | Yes |

## Merchant-Type Specific Documents

### sole_proprietorship

Required:
- `company_ntn`

Optional:
- `authority_letter`
- `taxpayer_registration_certificate`

### private_limited_company

Required:
- `company_ntn`
- `company_incorporation_certificate`

Optional:
- `memorandum_articles`
- `form_ii`
- `form_a`
- `board_resolution`
- `certificate_of_commencement`

### partnership

Required:
- `company_ntn`

Optional:
- `authority_letter`
- `partnership_deed`
- `form_c`

### limited_liability_partnership

Required:
- `company_ntn`
- `company_incorporation_certificate`

Optional:
- `authority_letter`
- `partnership_deed`
- `llp_form_iii`

### ngo_npo_charity

Required:
- `company_ntn`
- `company_incorporation_certificate`

Optional:
- `memorandum_articles`
- `form_ii`
- `form_a`
- `board_resolution`
- `annual_audited_accounts`
- `other_entity_certification`
- `secp_section_42_license`
- `risk_assessment_documents`
- `by_laws_rules_regulations`

### trust_society_association

Required:
- `company_ntn`

Optional:
- `board_resolution`
- `annual_audited_accounts`
- `other_entity_certification`

## Full Supported Document Field Names

Use these exact field names for file inputs:

- `owner_cnic_front`
- `owner_cnic_back`
- `next_of_kin_cnic_front`
- `next_of_kin_cnic_back`
- `utility_bill`
- `company_ntn`
- `authority_letter`
- `taxpayer_registration_certificate`
- `company_incorporation_certificate`
- `memorandum_articles`
- `form_ii`
- `form_a`
- `board_resolution`
- `certificate_of_commencement`
- `partnership_deed`
- `form_c`
- `llp_form_iii`
- `annual_audited_accounts`
- `other_entity_certification`
- `secp_section_42_license`
- `risk_assessment_documents`
- `by_laws_rules_regulations`

## Recommended Document Labels

| Field Name | Suggested Label |
|---|---|
| `owner_cnic_front` | Owner CNIC Front |
| `owner_cnic_back` | Owner CNIC Back |
| `next_of_kin_cnic_front` | Next Of Kin CNIC Front |
| `next_of_kin_cnic_back` | Next Of Kin CNIC Back |
| `utility_bill` | Utility Bill |
| `company_ntn` | Company NTN |
| `authority_letter` | Authority Letter |
| `taxpayer_registration_certificate` | Taxpayer Registration Certificate |
| `company_incorporation_certificate` | Company Incorporation Certificate |
| `memorandum_articles` | Memorandum & Articles |
| `form_ii` | Form II |
| `form_a` | Form A |
| `board_resolution` | Board Resolution |
| `certificate_of_commencement` | Certificate Of Commencement |
| `partnership_deed` | Partnership Deed |
| `form_c` | Form C |
| `llp_form_iii` | LLP Form III |
| `annual_audited_accounts` | Annual Audited Accounts |
| `other_entity_certification` | Other Entity Certification |
| `secp_section_42_license` | SECP Section 42 License |
| `risk_assessment_documents` | Risk Assessment Documents |
| `by_laws_rules_regulations` | By Laws / Rules / Regulations |

## Frontend Validation Recommendations

Mirror these on the frontend for good UX:

- All required fields must be non-empty.
- Validate email fields as proper email addresses.
- Validate `businessWebsite` as a proper URL.
- Validate `businessRegistrationDate` is not in the future.
- Validate `estimatedMonthlyTransactions` is an integer greater than 0.
- Validate `estimatedMonthlyVolume` is a number greater than 0.
- Validate uploaded file type before submit.
- Validate uploaded file size is `<= 10 MB`.
- Show dynamic document requirements based on `merchantType`.

## Conditional Document Logic For Frontend

When `merchantType` changes:
- Always require the 5 base documents.
- Add merchant-type specific required documents.
- Allow merchant-type specific optional documents.
- Hide or disable unsupported document fields for the selected merchant type.

Recommended UX:
- Show document fields grouped into:
  - Always Required
  - Required For Selected Merchant Type
  - Optional For Selected Merchant Type

## Backend Error Behaviors To Expect

Possible backend validation failures:

- `Content-Type must be multipart/form-data.`
- `Invalid multipart form payload.`
- `Field "<field>" must be provided once.`
- `Field "<field>" must be a text value.`
- `Unexpected field "<field>".`
- `Unexpected file field "<field>".`
- `Document "<field>" must be uploaded once.`
- `Document "<field>" is invalid.`
- `Document "<field>" exceeds the 10 MB limit.`
- `At least one document upload is required.`
- `Too many documents uploaded.`
- `Document "<documentType>" is not allowed for merchant type "<merchantType>".`
- `Document "<documentType>" is required.`
- `Document "<filename>" has an unsupported file type.`

Scalar field validation messages may also include:

- `This field is required.`
- `Submitter email must be a valid email.`
- `Business email must be a valid email.`
- `Business website must be a valid URL.`
- `Business registration date is invalid.`
- `Business registration date cannot be in the future.`
- `Estimated monthly transactions must be a whole number.`
- `Estimated monthly transactions must be greater than zero.`
- `Estimated monthly volume must be greater than zero.`

## Example Frontend FormData Keys

Text keys:

```text
email
ownerFullName
ownerPhone
businessName
businessPhone
businessEmail
businessAddress
businessWebsite
websiteCms
businessDescription
businessRegistrationDate
businessNature
merchantType
estimatedMonthlyTransactions
estimatedMonthlyVolume
accountTitle
bankName
branchName
accountNumberIban
swiftCode
nextOfKinRelation
```

Example file keys:

```text
owner_cnic_front
owner_cnic_back
next_of_kin_cnic_front
next_of_kin_cnic_back
utility_bill
company_ntn
```

## Example Frontend Submission Notes

- Send `estimatedMonthlyTransactions` and `estimatedMonthlyVolume` as string values inside `FormData`.
- Send `swiftCode` as empty string if not provided.
- For file inputs, append the selected `File` object using the exact document type as the key.
- Do not append unsupported or hidden file fields for the chosen merchant type.

## Suggested Section Order For UI

1. Submitter Information
2. Owner Information
3. Business Information
4. Business Classification
5. Financial Information
6. Next Of Kin
7. Required Documents
8. Optional Documents

