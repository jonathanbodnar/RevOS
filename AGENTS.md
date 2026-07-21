# AGENTS.md — RevOS

> Entry point for AI coding agents (Codex, Cursor, Claude, etc.) working in this
> repository. Read this file first. It gives you the mental model, the ground
> rules, and links to the full documentation graph under [`docs/`](./docs).

## 1. What RevOS is (one paragraph)

RevOS is a **multi-tenant clinic platform with integrated billing**. A single
**super admin** company (RevOS) onboards **clinics**; each clinic manages its own
**customers** (patients). All money moves through **one shared LunarPay merchant**
(card data is tokenized by Fortis Elements — raw PANs never touch RevOS). On top
of raw payments, RevOS runs a **revenue-share reporting** engine (splitting each
payment between RevOS and the clinic, netting out implementor commissions,
advanced costs, and payouts) and an **InBody** body-composition integration that
ingests scan results and auto-pairs them to customers by phone number.

## 2. Tech stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 15 (App Router), React 18, TypeScript (strict) |
| Styling | Tailwind CSS |
| ORM / DB | Prisma → PostgreSQL (Supabase-hosted; pooled URL at runtime, direct URL for migrations) |
| Auth | NextAuth (Credentials provider, JWT sessions), bcryptjs |
| Validation | Zod |
| Hosting | Railway (`ample-solace`: production = revosportal.com/main, Dev = dev.revosportal.com/dev); nightly reconcile cron via GitHub Actions (`.github/workflows/reconcile-cron.yml`) |
| External APIs | LunarPay (payments) + Fortis Elements (card tokenization), LookinBody / InBody Web API |

## 3. Repository map

```
RevOS/
├── AGENTS.md                ← you are here
├── README.md                Human-facing quickstart
├── FUTURE_SCOPE.md          Unbuilt roadmap (charting, KPIs, eLearning, chat, HIPAA infra)
├── docs/                    ← FULL documentation graph (read these before large changes)
│   ├── README.md            Docs index + how the docs link together
│   ├── architecture.md      System overview + diagrams (module map, request lifecycle, tenancy)
│   ├── data-model.md        Prisma models + ER diagram + money conventions
│   ├── auth-and-tenancy.md  Roles, sessions, impersonation, route guards
│   ├── api-reference.md     Every page route + API route (method, guard, purpose)
│   ├── payments.md          LunarPay client, Fortis tokenization, charges/subs/schedules/holds/links
│   ├── reporting.md         Revenue-share math (the clinic-balance formula lives here)
│   ├── inbody.md            InBody ingestion, phone auto-pairing, admin tooling
│   ├── operations.md        Env vars, commands, cron, deploy, security caveats
│   └── glossary.md          Domain vocabulary (down payment, care credit, master link, …)
├── prisma/
│   ├── schema.prisma        Source of truth for the data model
│   └── seed.ts              Creates the first super admin
├── scripts/e2e-smoke.mjs    Smoke test script
├── src/
│   ├── app/                 App Router: pages, layouts, and /api route handlers
│   ├── components/          Shared UI (AppShell, sidebar nav, icons, csv/copy buttons)
│   └── lib/                 Server logic (see §5)
└── vercel.json              Cron schedule (nightly subscription reconciliation)
```

## 4. Mental model (the four subsystems)

1. **Tenancy & auth** — `SUPER_ADMIN` vs `CLINIC_ADMIN`. Super admins can
   *impersonate* a clinic (audit-logged) to operate inside its workspace. See
   [`docs/auth-and-tenancy.md`](./docs/auth-and-tenancy.md).
2. **Payments** — a thin REST client (`src/lib/lunarpay.ts`) over the single
   LunarPay merchant; Fortis Elements tokenizes cards client-side. Concepts:
   charges, refunds, subscriptions, installment schedules, auth holds, hosted
   checkout / reusable payment links, save-card links, and "master" links. See
   [`docs/payments.md`](./docs/payments.md).
3. **Reporting / revenue share** — `src/lib/reporting.ts` + `src/lib/fees.ts`
   split every real charge between RevOS and the clinic and compute the running
   balance RevOS owes each clinic. See [`docs/reporting.md`](./docs/reporting.md).
4. **InBody** — `src/lib/inbody*.ts` ingest LookinBody webhooks and auto-pair
   scans to customers by normalized phone. See [`docs/inbody.md`](./docs/inbody.md).

## 5. `src/lib/` cheat-sheet (where server logic lives)

| File | Responsibility |
| --- | --- |
| `prisma.ts` | Prisma client singleton. |
| `auth.ts` | NextAuth config; JWT ↔ session shape; impersonation encoding. |
| `session.ts` | Server-component guards: `requireSession` / `requireSuperAdmin` / `requireClinicContext`. |
| `api-guard.ts` | Route-handler guards: `requireClinicApi` / `requireSuperAdminApi` / `requireSuperAdminClinicApi`. |
| `route-params.ts` | `requireStringParams` — validates `[id]` path params before Prisma queries. |
| `validators.ts` | Zod email validators. |
| `lunarpay.ts` | LunarPay REST client (all payment endpoints). |
| `master-link.ts` | Constants for configurable "master" payment links. |
| `subscription-reconcile.ts` | Self-healing backfill of recurring charges from LunarPay counters. |
| `failed-charge.ts` | Records declined charges as `status:"failed"` (never counted as revenue). |
| `notify.ts` | Fire-and-forget outbound webhook on failed payment. |
| `reporting.ts` | Revenue-share economics (`calcFee`, `reverseFee`, per-transaction splits). |
| `fees.ts` | Processing-fee constants + `calcFee`. |
| `implementor.ts` | Resolve/create sales implementor by name for attribution. |
| `inbody.ts` / `inbody-ingest.ts` / `inbody-display.ts` | InBody API client, ingestion, display formatting. |
| `audit.ts` | `logAudit()` — writes `AuditLog` rows; never throws. |
| `csv.ts` / `format.ts` / `phone.ts` | CSV building, money/date formatting, phone normalization. |

## 6. Conventions & invariants (do not break these)

- **Money is integer cents everywhere** in the DB and low-level API. Only two
  places use dollars: the legacy `createCheckoutSession` LunarPay endpoint and
  user-facing formatting (`formatMoneyCents`).
- **Never store raw card data.** Cards are tokenized by Fortis Elements
  client-side; the server only ever handles a `tokenizeId` → LunarPay
  `paymentMethodId`.
- **The customer-facing 3.9% + $0.39 fee is RevOS revenue** and is added on top
  of the clinic's base price. `reverseFee()` recovers the base for reporting.
- **Recurring charges are identified by the description marker
  `"Subscription renewal"`** — both the webhook and the reconciler write it, and
  the reporting page keys off `/subscription renewal/i`. Don't change this string
  without updating all three.
- **Reconciliation counts `successTrxns`, never `nextPaymentOn`** (the latter
  advances on failed attempts too). See `subscription-reconcile.ts`.
- **Webhook handlers return HTTP 200 even on internal error** (deliveries are
  fire-and-forget; we don't want infinite sender retries). Idempotency is done
  with deterministic charge ids.
- **`/webhooks/*` are aliases** — `src/app/webhooks/{lunarpay,inbody}/route.ts`
  just re-export `POST` from `src/app/api/webhooks/*`. Change the `/api/` copy.
- **Sensitive clinic operations require super admin** even inside a clinic
  context (refunds, delete/merge customer, remove/reassign card, cancel/reschedule
  subscription or schedule, care-credit edits) via `requireSuperAdminClinicApi`.
- **Audit everything sensitive** with `logAudit()`.

## 7. Setup & common commands

```bash
npm install
cp .env.example .env          # fill in DB, LunarPay, InBody, NextAuth secrets
npm run db:push               # sync schema.prisma to the DB (dev)
npm run db:seed               # create the first super admin
npm run dev                   # http://localhost:3000/login
```

| Command | Purpose |
| --- | --- |
| `npm run dev` | Next.js dev server. |
| `npm run build` | `prisma generate && next build`. |
| `npm run start` | Run the production build. |
| `npm run db:push` | Push `schema.prisma` to DB (dev, no migration file). |
| `npm run db:migrate` | Create/apply a migration. |
| `npm run db:seed` | Seed the super admin. |
| `npm run db:studio` | Prisma Studio. |
| `npm run lint` | Next.js lint. |

Full env reference and deploy notes: [`docs/operations.md`](./docs/operations.md).

## 8. Safety notes for agents

- `.env` holds live secrets and is git-ignored — never print, commit, or echo it.
- Two endpoints are **intentionally unauthenticated and must be removed before
  production**: `/api/health/login-check` and `/api/debug/lunarpay-intentions`.
  Treat them as debug-only.
- The database is a shared Postgres. Prefer `db:push` against a dev database;
  never run destructive migrations against prod. IDEs must not connect to prod
  (see `FUTURE_SCOPE.md` §9.5).
- When unsure how a subsystem works, read the matching file in [`docs/`](./docs)
  before editing — the docs are kept in sync with the code and cite exact paths.
