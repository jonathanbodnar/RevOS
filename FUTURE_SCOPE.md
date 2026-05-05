# RevOS — Future scope

This document tracks **everything in the full RevOS spec that is NOT yet
implemented** in the current codebase. The goal is to preserve the complete
product vision so we can pick up each area in isolation.

The features that _are_ implemented today are:

- Super admin role + clinic creation
- "Login as clinic" impersonation (audit-logged)
- Clinic admin role
- Customer CRUD scoped per clinic
- LunarPay integration: customers, payment methods, charges, refunds,
  subscriptions, hosted checkout (payment links)
- Customer-facing save-card link page
- Audit log basics

Everything below is deliberately **out of scope for the current build**.

---

## 1. Additional user roles

We currently have `SUPER_ADMIN` and `CLINIC_ADMIN`. Remaining roles from
the spec:

### 1.1 Provider

- Clinic-scoped.
- Can access **only assigned customers** (new `customer_provider`
  assignment table).
- Can create and edit charts / notes for assigned customers.
- Can view InBody data for assigned customers.
- Can generate payment links and add payment methods for assigned customers.
- **Cannot** refund, delete, or manipulate global billing records.

### 1.2 Billing Department

- Managed by `SUPER_ADMIN`.
- Cross-clinic read on billing data.
- Can refund, delete, and create manual charges.
- Can manage disputes.
- All actions write an elevated audit trail row.

### 1.3 Customer (no login)

- Already represented in the DB without auth.
- Receives payment/save-card links by email (SMS later).
- Supports reassignment across clinics by super admin **without** losing
  charts, payments, or InBody history.

### Data model changes

- `Provider` and `BillingUser` can reuse `User.role` (add `PROVIDER`,
  `BILLING_DEPT`).
- Add `CustomerProviderAssignment { providerId, customerId, startedAt, endedAt? }`.
- Add `ClinicReassignment { customerId, fromClinicId, toClinicId, byUserId, at }`
  for audit of moves (customer record itself just updates `clinicId`).

---

## 2. Charting system

### Features

- Per-customer charts (SOAP-style notes, free-text + structured fields).
- Provider-authored notes with **version history** (every edit is a new
  immutable row; "current" view is a head pointer).
- Timestamped, attributed edits.
- Attachments (images, PDFs) stored in S3 with signed URLs.
- Exportable PDF view.
- Simple text search within a clinic.

### Data model

```prisma
model Chart {
  id          String   @id @default(cuid())
  customerId  String
  clinicId    String
  createdById String
  // The current head revision
  headRevisionId String?
  createdAt   DateTime @default(now())
}

model ChartRevision {
  id          String   @id @default(cuid())
  chartId     String
  authorId    String
  title       String
  bodyJson    String   // structured SOAP or WYSIWYG
  createdAt   DateTime @default(now())
}

model ChartAttachment {
  id         String @id @default(cuid())
  chartId    String
  s3Key      String
  filename   String
  mimeType   String
  createdAt  DateTime @default(now())
}
```

### HIPAA requirements

- Encrypted at rest (DB + S3).
- TLS everywhere.
- Provider<>customer access check on every read.
- Access logs: every chart read and write is an `AuditLog` row with
  `action="chart.read"` / `"chart.write"`.

---

## 3. InBody integration

### Features

- Nightly sync (or webhook if available) of InBody scan results into
  customer records.
- Structured storage of biometric metrics (weight, body-fat %, lean mass,
  visceral-fat level, timestamped).
- Historical trend view per customer.
- Retry / backoff on ingestion failure; dead-letter queue visible to
  super-admin.
- Validation layer (reject out-of-range values, flag anomalies).

### Data model

```prisma
model InBodyScan {
  id            String   @id @default(cuid())
  customerId    String
  scannedAt     DateTime
  weightKg      Float?
  bodyFatPct    Float?
  leanMassKg    Float?
  visceralFat   Float?
  rawJson       String   // full InBody payload for fidelity
  sourceVendor  String   // "inbody"
  ingestedAt    DateTime @default(now())
  @@index([customerId, scannedAt])
}

model IntegrationIngestionError {
  id        String   @id @default(cuid())
  source    String   // "inbody"
  payload   String
  error     String
  createdAt DateTime @default(now())
}
```

### Questions

- Which InBody API / file feed (USB export, cloud API)?
- Patient matching — MRN, email, or external-id?

---

## 4. Payment system — post-MVP

The current codebase covers the LunarPay happy path. Remaining work:

### 4.1 Webhooks

- Implement `/api/webhooks/lunarpay` to receive:
  - `checkout.session.completed` — mark `CheckoutSession.status = completed`,
    reconcile the new `Charge`, link `PaymentMethod` to local customer,
    auto-create `Subscription` / `PaymentSchedule` if the session had
    `mode=subscription|installments`.
  - ACH settlement — update `Charge.status` from `pending` to `paid` or
    `failed` when LunarPay settles 3–5 business days later.
- Verify `X-LunarPay-Signature` (HMAC-SHA256 with `LUNARPAY_WEBHOOK_SECRET`).
- Idempotency: store `(event, sessionId, transactionId)` to avoid double-
  processing on retries.

### 4.2 Payment schedules (installment plans)

- LunarPay endpoint is already wrapped in `lunarpay.ts` (`createSchedule`,
  `getSchedule`, `cancelSchedule`).
- UI pieces missing:
  - "New installment plan" form on the customer detail page (amount + date
    rows, up to 100).
  - Schedule detail page showing each payment row (`pending/paid/failed`).
  - Cancel-schedule action + audit log row.

### 4.3 Default RevOS billing model

The product spec requires auto-billing each clinic:

- `$1,500` setup fee at clinic creation (one-time charge via a super-admin
  method: could be a hosted checkout generated with `mode=payment`).
- `$250/month` recurring starting 30 days later (`mode=subscription`,
  `frequency=monthly`, `start_on = +30 days`).
- Store `Clinic.billingStatus` (`trial | active | past_due | cancelled`).
- Lockout rules if past_due.

### 4.4 ACH / eCheck UI polish

- Admin "Add bank account" flow (Fortis Elements with `paymentMethods:["ach"]`).
- Show bank type + routing masked in list.
- Tell clinic admins that ACH charges return `pending` for up to 5 days.

### 4.5 Manual charges (Billing Department)

- Add an "Admin-only manual charge" path where Billing can pick any clinic +
  customer, record a manual amount, and optionally charge.
- Mark these with `manual=true` and heavy audit metadata.

### 4.6 Disputes

- Manual state: `Charge.disputed=true`, `disputedAt`, `disputeReason`.
- UI tab on customer page: Dispute list.
- Later: wire to LunarPay / Fortis dispute feed if available.

### 4.7 Payment delinquency + dunning

- On failed subscription charge, move sub to `past_due`, start email series.
- Dashboard widget: "subscriptions needing attention".

### 4.8 Receipts + customer emails

- Transactional emails (SES / Postmark) for:
  - Charge succeeded
  - Subscription started / renewed / cancelled
  - Payment link opened
  - Refund issued

---

## 5. Audit / KPI system

Spec calls for clinic performance KPIs with flagging rules.

### Features

- Super admin defines `KPI { name, metric, comparison, threshold, scope }`.
- Example: `body-fat % change over 90 days > +3 → flag`.
- Background job evaluates KPIs nightly per customer.
- `KPIFlag { customerId, kpiId, status, evaluatedAt, details }`.
- Clinic-level KPI dashboard (per-clinic filter, flagged customer list).
- Global super-admin KPI dashboard (cross-clinic + roll-up).
- Export to CSV.

### Data model

```prisma
model KPI {
  id         String @id @default(cuid())
  name       String
  metric     String // "body_fat_delta", "visit_count", etc.
  comparison String // "gt", "lt", "eq"
  threshold  Float
  windowDays Int?
  clinicId   String? // null = global
  createdById String
  createdAt  DateTime @default(now())
}

model KPIFlag {
  id           String @id @default(cuid())
  kpiId        String
  customerId   String
  clinicId     String
  status       String // "open", "resolved", "dismissed"
  severity     String // "info", "warn", "critical"
  detailsJson  String
  evaluatedAt  DateTime
  resolvedAt   DateTime?
}
```

### Infra

- Nightly cron (SQS + Lambda or a Next.js cron route with scheduled worker).
- Idempotent per `(kpiId, customerId, evaluation_window)`.

---

## 6. eLearning system

### Features

- Super-admin-authored training modules.
- WYSIWYG / Markdown editor for majority of content (candidates: TipTap,
  Lexical, EditorJS).
- Video content (S3-hosted or Mux).
- Module ordering, categories, tags.
- Role-based visibility (show to providers, clinic admins, or both).
- Per-user completion tracking + quiz support later.

### Data model

```prisma
model LearningModule {
  id           String @id @default(cuid())
  title        String
  slug         String @unique
  audience     String // "CLINIC_ADMIN" | "PROVIDER" | "BOTH"
  contentJson  String // WYSIWYG output
  videoUrl     String?
  position     Int
  publishedAt  DateTime?
}

model LearningProgress {
  id        String @id @default(cuid())
  userId    String
  moduleId  String
  status    String // "not_started", "in_progress", "completed"
  updatedAt DateTime @updatedAt
  @@unique([userId, moduleId])
}
```

---

## 7. Internal chat assistant

Spec: bottom-right chat widget for internal staff (providers + clinic
admins) to ask questions about processes (eLearning), systems, and
controlled customer data.

### Architecture

- Floating chat widget component (`<ChatDock />`) available on all
  authenticated pages.
- Queries go to an LLM backend we control; we pass **a limited,
  role-filtered context** (never raw PHI).
- Two query "modes":
  1. **Training / processes**: RAG over eLearning modules + internal docs.
  2. **Customer-aware**: constrained tool-use where the model can look up
     "Does customer X have a default payment method?" without ever seeing
     identifiers it doesn't need.
- All interactions are logged (`ChatLog { userId, clinicId, question,
  answer, metadata, createdAt }`).

### Compliance constraints

- No raw PHI in prompts. PHI gets tokenized before being sent to any
  third-party LLM.
- The LLM response is post-filtered server-side for PHI leakage.
- If running locally (e.g. a HIPAA-BAA'd Bedrock or Azure OpenAI under BAA),
  relax the tokenization rule; otherwise, strict.

---

## 8. Multi-tenant data model polish

The current schema is already multi-tenant, but further:

- Row-level security in Postgres: add a `clinic_id` policy to every
  tenant-scoped table when we migrate off SQLite.
- Soft-delete flags on `Customer`, `PaymentMethod`, `Charge` (some already
  have `isActive`) to preserve audit continuity.
- Backfill scripts / migrations for cross-clinic customer moves.

---

## 9. HIPAA-compliant infrastructure (AWS)

### 9.1 Compute / network

- EC2 (or ECS/Fargate) behind an ALB, in private subnets.
- VPC with public/private separation; NAT for outbound.
- Security groups: DB only accepts traffic from app subnet.
- ALB terminates TLS (ACM cert); HTTP → HTTPS redirect.
- WAF in front of ALB.

### 9.2 Data stores

- **RDS Postgres** with encryption at rest (KMS), automated backups,
  PITR, Multi-AZ.
- **S3** with default encryption, versioning, and blocked public access
  for all PHI-bearing buckets (charts, attachments).
- Separate buckets/prefixes for:
  - PHI (charts/attachments)
  - Non-PHI (app assets, eLearning videos)

### 9.3 Secrets + config

- AWS Secrets Manager for `LUNARPAY_SECRET_KEY`, DB creds, NextAuth secret.
- No secrets in env-vars in build artifacts.

### 9.4 Logging / audit

- CloudTrail for all AWS API calls.
- CloudWatch Logs for app logs with PII-scrubbing middleware.
- Separate account or prefix for audit logs so they're write-only to the
  app IAM role.

### 9.5 Dev / prod separation

- **Separate AWS accounts** for `dev` and `prod`.
- Dev DB has only synthetic/test data.
- CI/CD pushes from `dev` → `prod`.
- **IDEs (Cursor, Claude) never connect to prod.** Enforced at the network
  boundary (no prod DB creds in developer environments).
- Telemetry disabled where possible; no PHI in logs or LLM prompts.

### 9.6 Disaster recovery

- RDS automated backups (30-day retention), weekly snapshot to a DR region.
- S3 cross-region replication on PHI buckets.
- Runbook: RTO / RPO documented.

### 9.7 Access control

- IAM roles per service.
- Break-glass admin account with MFA + audit email.
- Production DB access is via SSM port-forward only; reviewed quarterly.

### 9.8 BAA

- Sign BAA with AWS.
- Sign BAA with LunarPay / Fortis for payments.
- Sign BAA with any email / SMS / LLM vendors that might see PHI.

---

## 10. Compliance controls (app layer)

- [ ] RBAC matrix defined per route (current code only has
      SUPER_ADMIN / CLINIC_ADMIN checks).
- [ ] Audit logs for every **read** of PHI (currently we log writes).
- [ ] Export of audit trail on demand (compliance requests).
- [ ] Data retention: configurable per-clinic retention on charts,
      audit logs, payment records.
- [ ] Breach detection: alert on abnormal access patterns (many customers
      viewed by one provider in a short window, etc.).
- [ ] Two-factor authentication for super admin + optional for clinic
      admin / provider. TOTP first; WebAuthn later.
- [ ] Session timeout + forced re-auth for sensitive actions (refunds,
      deleting charges, impersonation).

---

## 11. UX enhancements deferred

- Global search (customers, charges) with clinic-scoped results.
- Saved-view tables with column preferences.
- CSV export on charges / subscriptions.
- Dark mode.
- Empty-state illustrations.
- Activity feed ("Dr. X added a note to Customer Y — 2m ago").

---

## 12. Testing

Currently no tests. To add:

- **Unit**: LunarPay client mocked against a fake server fixture; pure
  helpers (`format.ts`, `slugify`).
- **Integration**: Next.js route handlers with a test DB and `msw` (or a
  mock LunarPay backend).
- **E2E**: Playwright flows for "super admin creates clinic → impersonates
  → adds customer → generates payment link".
- **Contract**: Record/replay LunarPay webhook samples and verify our
  handler idempotency.

---

## 13. Observability

- Structured logs (pino or similar) with `clinicId` context.
- Sentry for frontend + server errors.
- Datadog / OpenTelemetry for traces.
- Health check endpoint `/api/healthz`.

---

## 14. Agency / provisioning automation (optional)

LunarPay has a separate **Agency API** (`lp_agency_…`) for registering
sub-merchants and onboarding them to Fortis. RevOS currently uses a
single merchant — not an agency. If we later want each clinic on its own
Fortis merchant (changes risk profile but cleaner accounting), migrate to:

- Agency key in RevOS super-admin config.
- Clinic creation triggers `POST /api/v1/agency/merchants` and stores the
  returned `lp_sk_`/`lp_pk_` per-clinic.
- Clinic onboarding flow embeds the Fortis MPA form.
- All per-clinic API calls use that clinic's keys instead of the shared
  merchant keys.

This is a significant refactor — only do it if the business model
requires per-clinic settlement / risk separation.

---

## Rough implementation order (suggestion)

1. LunarPay webhooks (required for data correctness in prod).
2. Provider role + customer assignment.
3. Charting + InBody (core product).
4. RevOS billing (self-charge clinics $1,500 + $250/mo).
5. KPI / audit dashboards.
6. eLearning.
7. HIPAA infra hardening on AWS.
8. Internal chat.
9. Agency / per-clinic merchants (only if needed).
