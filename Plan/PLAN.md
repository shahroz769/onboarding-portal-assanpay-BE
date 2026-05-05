# Onboarding Portal — Backend Plan

## Stack Recommendations

### ORM: Drizzle ORM (recommended over Prisma)

|             | Drizzle                         | Prisma                              |
| ----------- | ------------------------------- | ----------------------------------- |
| Bun support | Native, first-class             | Works but has query engine overhead |
| Performance | Direct SQL, no runtime overhead | Extra query engine process          |
| Type-safety | Full, SQL-like syntax           | Full, custom DSL                    |
| Migrations  | Lightweight `drizzle-kit`       | Heavier CLI                         |
| Bundle size | ~50KB                           | ~2MB+ engine                        |

**Verdict:** Drizzle aligns perfectly with the Bun + Hono lightweight philosophy.

### Email: Nodemailer + SMTP (recommended over Resend)

|                | Nodemailer + SMTP                                  | Resend                        |
| -------------- | -------------------------------------------------- | ----------------------------- |
| Cost           | Free (use Brevo free 300/day, or your own SMTP)    | Free tier: 100/day, then paid |
| Vendor lock-in | None — swap SMTP providers anytime                 | Tied to Resend API            |
| Templates      | Use any templating (React Email, MJML, Handlebars) | React Email built-in          |
| Setup          | Moderate                                           | Very easy                     |
| Control        | Full control over delivery                         | Managed                       |

**Verdict:** Nodemailer gives you flexibility. In production, point it at Brevo, Mailgun, or your own SMTP relay. Zero lock-in.

### File Storage: Google Drive for now, Hetzner Object Storage later

Google Drive can be used in the first version if the business needs document access restricted to company Google accounts.

**Recommended temporary approach:**

- Upload documents to Google Drive through the backend
- Create a dedicated folder structure per merchant
- Store `file_id`, `folder_id`, filename, mime type, checksum, and links in the database
- Restrict file sharing to approved company Google accounts only
- Keep audit logs for upload, access, review, and replacement actions

**Long-term direction:**

- Abstract storage behind a provider interface
- Start with Google Drive as the current provider
- Migrate later to Hetzner Object Storage without changing business logic

### Auth: Custom JWT (access + refresh tokens)

For this specific flow (admin-created users, direct password creation, RBAC with policies), a custom implementation gives the most control.

- **Access token:** 15-min expiry, stored in memory on frontend
- **Refresh token:** 7-day expiry, stored in httpOnly cookie + DB
- **Password hashing:** `Bun.password.hash()` (built-in Argon2)

### Deployment: Hetzner + Coolify

Use Hetzner infrastructure with Coolify for deployment orchestration and server management.

**Recommended setup:**

- Hetzner VPS
- Coolify-managed application deployment
- Docker image/container deployment through Coolify
- PostgreSQL hosted on the same server or a separate managed node
- Coolify-managed SSL, domains, and reverse proxy

---

## Complete Tech Stack

```
Runtime:        Bun
Framework:      Hono
Database:       PostgreSQL
ORM:            Drizzle ORM
Auth:           Custom JWT (access + refresh)
Real-time:      Bun native WebSocket
Email:          Nodemailer + SMTP
File Storage:   Google Drive for now → Hetzner Object Storage later
Validation:     Zod
Deployment:     Hetzner + Coolify
Process Mgmt:   Coolify managed containers
Reverse Proxy:  Coolify managed proxy
```

---

## Database Schema Design

```
┌─────────────────────────────────────────────────────────┐
│                    CORE ENTITIES                         │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  users ─────────┐                                       │
│  (employees)    │                                       │
│                 ├──► access_policies ──► policy_queues   │
│                 │                           │            │
│  merchants ─────┤                      queues            │
│                 │                           │            │
│  merchant_      │    cases ◄───────────────┘            │
│  documents      │      │                                │
│                 │      ├── case_comments (chatter)      │
│  merchant_      │      ├── case_history                 │
│  timeline       │      └── case_documents               │
│                 │                                       │
│  notifications  │    tokens (form, go-live)             │
│                 │                                       │
│  email_log      │    merchant_credentials               │
└─────────────────────────────────────────────────────────┘
```

### Key Tables

| Table                    | Purpose                                                                                                         |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `users`                  | Portal users (name, email, employee_id, password_hash, role_type, access_policy_id, status, created_by_user_id) |
| `access_policies`        | Operational access policies for queue permissions, mainly for supervisor/employee scope                         |
| `policy_queues`          | M2M: which queues a policy grants access to                                                                     |
| `queues`                 | Queue definitions (Documents Review, Sub Merchant Form, Agreement, MID, Support Tickets, Going Live)            |
| `merchants`              | All merchant data from form (business name, contact, type, status, onboarding_stage)                            |
| `merchant_documents`     | Uploaded documents with review status (approved/rejected/pending, rejection_reason)                             |
| `merchant_timeline`      | Audit trail: every event from form fill to live                                                                 |
| `cases`                  | Central case table (queue_id, merchant_id, owner_id, current_stage_id, priority, created_at)                    |
| `case_stage_definitions` | Stage definitions per case type / queue                                                                         |
| `case_stage_transitions` | Allowed transitions between stages for each case type                                                           |
| `case_comments`          | Chatter: internal comments with @mentions                                                                       |
| `case_history`           | Field-level change log (who changed what, when)                                                                 |
| `case_documents`         | Files attached to specific cases                                                                                |
| `notifications`          | All notifications (mention, assignment, status change, etc.)                                                    |
| `tokens`                 | Resubmission form tokens and go-live tokens (with expiry, type)                                                 |
| `merchant_credentials`   | MID credentials (AES-encrypted email and password)                                                              |
| `email_log`              | Record of every email sent (to, subject, template, case_id)                                                     |

---

## API Architecture & Module Breakdown

```
src/
├── index.ts                    # App entry point
├── config/
│   ├── env.ts                  # Environment variables (Zod validated)
│   ├── database.ts             # Drizzle + PostgreSQL connection
│   └── websocket.ts            # WebSocket setup
├── db/
│   ├── schema/                 # Drizzle schema files
│   │   ├── users.ts
│   │   ├── merchants.ts
│   │   ├── cases.ts
│   │   ├── queues.ts
│   │   ├── notifications.ts
│   │   └── tokens.ts
│   └── migrations/             # Auto-generated by drizzle-kit
├── middleware/
│   ├── auth.ts                 # JWT verification
│   ├── rbac.ts                 # Role/queue access check
│   ├── rateLimiter.ts          # Rate limiting (public routes)
│   └── errorHandler.ts         # Global error handler
├── modules/
│   ├── auth/
│   │   ├── auth.routes.ts      # Login, refresh, logout
│   │   ├── auth.service.ts
│   │   └── auth.schemas.ts     # Zod validation
│   ├── users/
│   │   ├── users.routes.ts     # CRUD, work details
│   │   ├── users.service.ts
│   │   └── users.schemas.ts
│   ├── access-policies/
│   │   ├── policies.routes.ts  # CRUD, assign queues
│   │   ├── policies.service.ts
│   │   └── policies.schemas.ts
│   ├── merchants/
│   │   ├── merchants.routes.ts # List, detail, timeline
│   │   ├── merchants.service.ts
│   │   ├── merchants.schemas.ts
│   │   └── form.routes.ts      # Public form submission
│   ├── cases/
│   │   ├── cases.routes.ts     # List by queue, detail, case-specific stage transitions
│   │   ├── cases.service.ts
│   │   ├── cases.schemas.ts
│   │   ├── automation.ts       # Auto-create next case on close
│   │   └── handlers/           # Queue-specific logic
│   │       ├── documentReview.ts
│   │       ├── subMerchantForm.ts
│   │       ├── agreement.ts
│   │       ├── mid.ts
│   │       ├── goingLive.ts
│   │       └── supportTicket.ts
│   ├── comments/
│   │   ├── comments.routes.ts  # Chatter CRUD, mentions
│   │   └── comments.service.ts
│   ├── notifications/
│   │   ├── notifications.routes.ts
│   │   ├── notifications.service.ts
│   │   └── websocket.handler.ts # Live push
│   ├── dashboard/
│   │   ├── dashboard.routes.ts
│   │   └── dashboard.service.ts
│   ├── documents/
│   │   ├── documents.routes.ts # Upload, download, review
│   │   └── documents.service.ts
│   └── email/
│       ├── email.service.ts    # Nodemailer wrapper
│       └── templates/          # HTML email templates
│           ├── documentRejection.ts
│           ├── credentials.ts
│           ├── userCreated.ts
│           ├── agreementUpload.ts
│           └── goLive.ts
├── utils/
│   ├── crypto.ts               # Token generation, encryption
│   ├── pagination.ts           # Shared pagination helper
│   └── logger.ts               # Structured logging
└── types/
    └── index.ts                # Shared TypeScript types
```

---

## Detailed API Endpoints

### Auth

| Method | Endpoint            | Description                 |
| ------ | ------------------- | --------------------------- |
| POST   | `/api/auth/login`   | Login with email + password |
| POST   | `/api/auth/refresh` | Refresh access token        |
| POST   | `/api/auth/logout`  | Invalidate refresh token    |

### Users

| Method | Endpoint               | Description                                                      |
| ------ | ---------------------- | ---------------------------------------------------------------- |
| GET    | `/api/users`           | List users with filters                                          |
| GET    | `/api/users/:id`       | User detail + work stats                                         |
| GET    | `/api/users/:id/cases` | User's open/closed cases                                         |
| POST   | `/api/users`           | Create user with email + password, subject to creator role rules |
| PATCH  | `/api/users/:id`       | Update user                                                      |
| DELETE | `/api/users/:id`       | Deactivate user (soft delete)                                    |

### Access Policies (Admin+)

| Method | Endpoint            | Description                          |
| ------ | ------------------- | ------------------------------------ |
| GET    | `/api/policies`     | List policies                        |
| POST   | `/api/policies`     | Create policy with queue assignments |
| PATCH  | `/api/policies/:id` | Update policy                        |
| DELETE | `/api/policies/:id` | Delete policy                        |

### Merchants

| Method | Endpoint                               | Description                        |
| ------ | -------------------------------------- | ---------------------------------- |
| POST   | `/api/public/merchant-form`            | Public: Submit onboarding form     |
| POST   | `/api/public/merchant-resubmit/:token` | Public: Resubmit rejected docs     |
| POST   | `/api/public/agreement-upload/:token`  | Public: Merchant uploads agreement |
| POST   | `/api/public/go-live-request/:token`   | Public: Request going live         |
| GET    | `/api/merchants`                       | List merchants (filterable)        |
| GET    | `/api/merchants/:id`                   | Merchant detail                    |
| GET    | `/api/merchants/:id/timeline`          | Full timeline                      |

### Cases

| Method | Endpoint                              | Description                                                |
| ------ | ------------------------------------- | ---------------------------------------------------------- |
| GET    | `/api/cases`                          | List cases (filter by queue, stage, owner)                 |
| GET    | `/api/cases/:id`                      | Case detail                                                |
| PATCH  | `/api/cases/:id/assign`               | Assign/take ownership                                      |
| PATCH  | `/api/cases/:id/stage`                | Transition stage based on the case's configured stage flow |
| POST   | `/api/cases/:id/review`               | Submit document review decisions                           |
| POST   | `/api/cases/:id/send-rejection-email` | Send rejection email to merchant                           |
| POST   | `/api/cases/:id/upload-document`      | Upload case-specific file                                  |
| POST   | `/api/cases/:id/send-agreement`       | Send agreement link to merchant                            |
| POST   | `/api/cases/:id/credentials`          | Save MID credentials                                       |
| POST   | `/api/cases/:id/send-credentials`     | Send credentials to merchant                               |
| POST   | `/api/cases/:id/set-limits`           | Set testing/live limits                                    |
| POST   | `/api/cases/:id/close`                | Close case (triggers auto-create next)                     |

### Comments (Chatter)

| Method | Endpoint                  | Description                  |
| ------ | ------------------------- | ---------------------------- |
| GET    | `/api/cases/:id/comments` | List comments for case       |
| POST   | `/api/cases/:id/comments` | Add comment (with @mentions) |
| PATCH  | `/api/comments/:id`       | Edit comment                 |
| DELETE | `/api/comments/:id`       | Delete comment               |

### Notifications

| Method | Endpoint                      | Description                      |
| ------ | ----------------------------- | -------------------------------- |
| GET    | `/api/notifications`          | List user's notifications        |
| PATCH  | `/api/notifications/:id/read` | Mark as read                     |
| PATCH  | `/api/notifications/read-all` | Mark all as read                 |
| WS     | `/ws`                         | WebSocket for live notifications |

### Dashboard

| Method | Endpoint                         | Description                          |
| ------ | -------------------------------- | ------------------------------------ |
| GET    | `/api/dashboard/stats`           | Key metrics                          |
| GET    | `/api/dashboard/queue-summary`   | Cases per queue with stage breakdown |
| GET    | `/api/dashboard/recent-activity` | Recent timeline events               |

---

## Case Automation Flow

```
Merchant submits form
       │
       ▼
[Merchant created — status: "Pending Onboarding"]
       │
       ▼ (auto)
[Document Review Case — stage: New]
       │
       ├── Owner reviews docs → Approve/Reject each
       ├── If rejections → Send email with resubmission link
       ├── Merchant resubmits → Case goes to "Working" again
       └── All approved → Close case
              │
              ▼ (auto)
       [Sub Merchant Form Case — stage: New]
              │
              ├── Upload form → Send to EasyPaisa/DialogPay
              └── Close case
                     │
                     ▼ (auto)
              [Agreement Case — stage: New]
                     │
                     ├── Create agreement, upload
                     ├── Send upload link to merchant → stage: Pending (Merchant)
                     ├── Merchant uploads signed agreement
                     ├── Review → Close case
                     │
                     ▼ (auto)
              [MID Case — stage: New]
                     │
                     ├── Create MID on external portal
                     ├── Enter credentials (AES-encrypted storage)
                     ├── Apply testing limits
                     ├── Send credentials email + go-live link (active after 3 days)
                     ├── Close case → merchant status: "Testing"
                     │
                     ▼ (merchant action, ≥3 days later)
              Merchant opens go-live link → submits request
                     │
                     ▼ (auto)
              [Going Live Case — stage: New]
                     │
                     ├── Set live limits
                     ├── Send confirmation email
                     └── Close case → merchant status: "Live"
```

---

## Case Stages

Case stages are case-dependent. There is no single global stage pipeline for all case types.

Each queue or case type should define:

- its own list of allowed stages
- its own default starting stage
- its own allowed transitions
- whether QC exists for that case type

Examples:

- Documents Review: `New → Working → Pending Merchant → Closed`
- Agreement: `New → Drafting → Pending Merchant → Review → Closed`
- MID: `New → Working → Credentials Ready → Testing Limits Applied → Closed`
- Going Live: `New → Working → Live Limits Applied → Closed`
- Support Ticket: can have its own independent flow later

Implementation note:

- Store stage definitions in the database instead of hardcoding one enum for all cases
- Validate every stage transition against the case type's allowed workflow

---

## User Roles & Access

Use a single `users` table, but separate platform authority from operational access rules.

### Platform Roles

| Role        | Access                                              |
| ----------- | --------------------------------------------------- |
| Super Admin | Full access to everything, including admin creation |
| Admin       | Full access except super admin actions              |

### Operational Roles

| Role       | Access                                      |
| ---------- | ------------------------------------------- |
| Supervisor | Access to assigned queues + user work stats |
| Employee   | Access to assigned queues only              |

### User Creation Hierarchy

| Creator Role | Can Create                  |
| ------------ | --------------------------- |
| Super Admin  | Admin, Supervisor, Employee |
| Admin        | Supervisor, Employee        |
| Supervisor   | Employee                    |
| Employee     | No user creation access     |

Rules:

- Allow `admin` registration only through an env-gated backend route
- Do not expose unrestricted admin creation in the UI
- `admin` can create `supervisor` and `employee`
- `admin` can create `supervisor` and `employee`
- `supervisor` can create `employee`
- No public self-registration
- Every created user should store `created_by_user_id` for auditability

**Access Policy flow:**

1. Create a policy → give it a name + select queues
2. Assign the policy to a user
3. User can only see/work cases in their allowed queues
4. Access policies mainly apply to `supervisor` and `employee` operational scope

---

## User Creation Flow

```
Authorized user creates user (name, email, employee_id, role, policy, password)
       │
       ▼
Backend validates that the creator is allowed to create the target role
       │
       ▼
User is created immediately in active state
       │
       ▼
Optional email is sent to the user with account details or login instructions
```

Notes:

- Admin registration should be controlled by env configuration
- `admin` users should not be controlled only by queue policy; they also have platform-level permissions
- `supervisor` and `employee` should use access policies for queue-based restrictions

---

## Merchant Statuses (Enum)

```
form_submitted → documents_review → sub_merchant → agreement → testing → live → suspended
```

---

## Missing Features to Add

### Critical (Include Now)

1. **Audit logging** — Log every action (who, what, when, IP). Essential for compliance.
2. **Soft deletes** — Never hard-delete merchants, cases, or users.
3. **Email log** — Record every email sent (deliverability tracking, debugging).
4. **File type/size validation** — Enforce allowed types and max sizes on uploads.
5. **Rate limiting** — On all public endpoints (form submission, token verification).
6. **CORS configuration** — Lock down allowed origins.
7. **Input sanitization** — All merchant form fields (XSS prevention).
8. **Credential encryption** — MID credentials must be AES-encrypted at rest, not plaintext.
9. **Merchant status tracking** — Dedicated status enum (see above).
10. **Case priority levels** — High/Medium/Low for triage.

### Important (Phase 2)

11. **SLA tracking** — Time in each case stage, alerts when overdue.
12. **Auto-assignment rules** — Round-robin or load-based case assignment.
13. **Case escalation** — Auto-escalate if case sits in a stage too long.
14. **Merchant self-service portal** — Let merchants check their onboarding status.
15. **Bulk operations** — Assign/close multiple cases at once.
16. **Search** — Full-text search across merchants, cases, comments.
17. **Export/Reports** — CSV/Excel export of merchants, cases.
18. **2FA for portal users** — TOTP-based (Google Authenticator).
19. **Password policies** — Minimum length, complexity, expiry.
20. **Activity feed** — Dashboard showing real-time org-wide activity.

### Nice to Have (Phase 3)

21. **Email template editor** — Admin-editable email templates.
22. **Webhook support** — Notify external systems on status changes.
23. **Form builder** — Configurable onboarding form fields.
24. **Merchant categories** — Different onboarding flows per merchant type.
25. **API rate limiting per user** — Throttle heavy users.

---

## Implementation Phases

### Phase 1 — Foundation (Core Infrastructure)

- [ ] Project structure, config, database setup
- [ ] Drizzle schema + migrations
- [ ] Auth system (JWT, login, refresh/logout flow)
- [ ] User CRUD with admin-created passwords
- [ ] Access policies + RBAC middleware
- [ ] Error handling, validation, logging

### Phase 2 — Merchant & Cases Core

- [ ] Merchant form (public endpoint)
- [ ] Merchants list + detail + timeline
- [ ] Queue & case system (CRUD, case-dependent stage transitions)
- [ ] Document Review case handler (auto-create, review, reject/approve, resubmission)
- [ ] File upload system
- [ ] Email service + templates

### Phase 3 — Remaining Case Handlers

- [ ] Sub Merchant Form case handler
- [ ] Agreement case handler (upload link flow)
- [ ] MID case handler (credentials, go-live token with 3-day delay)
- [ ] Going Live case handler
- [ ] Case automation (auto-create chain on close)

### Phase 4 — Collaboration & Real-time

- [ ] Chatter/comments with @mentions
- [ ] Case history (field-level changes)
- [ ] WebSocket notifications (live push)
- [ ] Notification system (mention, assignment, status change)

### Phase 5 — Dashboard & Polish

- [ ] Dashboard stats & queue summary
- [ ] User work details (case load, metrics)
- [ ] Support Tickets queue
- [ ] Search & filtering refinement
- [ ] Email logging
- [ ] Audit log viewer

---

## Dependencies to Install

```bash
# Core
bun add hono zod drizzle-orm postgres
bun add -d drizzle-kit @types/bun typescript

# Auth & Security
bun add hono jose
# Password hashing: use Bun.password (built-in Argon2 — no extra dep)

# Email
bun add nodemailer
bun add -d @types/nodemailer

# Utilities
bun add nanoid dayjs
```
