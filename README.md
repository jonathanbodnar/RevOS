# RevOS

A multi-tenant clinic platform with integrated LunarPay billing. This repo is
the **foundational slice** of the full RevOS spec — it ships a clean admin +
clinic UI with a complete LunarPay payments integration.

For the full feature roadmap (charting, InBody, eLearning, internal chat,
audit KPIs, HIPAA/AWS infra), see [`FUTURE_SCOPE.md`](./FUTURE_SCOPE.md).

## What's built

**Super Admin**
- Sign in at `/login`.
- Dashboard of global activity (`/admin`).
- Create clinics with an initial clinic-admin user (`/admin/clinics/new`).
- "Login as clinic" button that scopes the session into any clinic's workspace
  (impersonation is audit-logged).
- Audit log viewer at `/admin/audit`.

**Clinic workspace** (for clinic admins, or super admins impersonating)
- Customer list + create (`/clinic/customers`).
- Customer detail with:
  - Payment methods (add card in-admin via Fortis Elements, or send a
    hosted save-card link to the customer).
  - One-time charges.
  - Refunds (partial or full).
  - Subscriptions (create, cancel).
  - Generate hosted payment links (invoices).
- Global clinic views: charges, subscriptions, payment links.

**Public**
- `/pay/save-card/[token]` — customer-facing page to add their card.
- `/pay/success` / `/pay/cancel` — returns from LunarPay hosted checkout.

## Payment architecture

All clinics charge through a **single LunarPay merchant** (one `lp_sk_` /
`lp_pk_` pair in `.env`). LunarPay has no native "clinic" concept, so RevOS:

1. Owns the `Customer → Clinic` mapping in its own database.
2. Tags every charge's description with `[Clinic Name] …` so the LunarPay
   dashboard is auditable.
3. Mirrors LunarPay payment methods, charges, subscriptions, and schedules
   locally for fast UI and scoping.

Raw card data never touches RevOS. The Fortis Elements iframe collects card
details directly to Fortis and returns a `ticket_id`; RevOS exchanges that
for a reusable `paymentMethodId` via LunarPay.

> **Note on email dedup:** LunarPay upserts customers by email under the
> single merchant. If two clinics create customers with the same email,
> they will share a LunarPay customer id (which is correct — same person,
> same card). The `[Clinic]` prefix on every charge description keeps it
> clear which clinic ran each transaction.

## Stack

- Next.js 15 (App Router) + React 18 + TypeScript
- Tailwind CSS
- Prisma ORM (SQLite in dev; swap to Postgres in prod)
- NextAuth (credentials / email + password, JWT sessions)
- bcryptjs for password hashing
- Zod for input validation

## Getting started

```bash
# 1. Install deps
npm install

# 2. Create .env (copy from example)
cp .env.example .env
#   Edit: LUNARPAY_SECRET_KEY, LUNARPAY_PUBLISHABLE_KEY, NEXTAUTH_SECRET

# 3. Create DB + seed super admin
npm run db:push
npm run db:seed

# 4. Run
npm run dev
# Sign in at http://localhost:3000/login
# Default creds: admin@revos.local / ChangeMe123!
```

## Environment variables

See [`.env.example`](./.env.example) for the full list.

Key settings:

| Var | Purpose |
| --- | --- |
| `DATABASE_URL` | Prisma connection string. SQLite locally. |
| `NEXTAUTH_SECRET` | JWT signing key. Generate with `openssl rand -base64 32`. |
| `LUNARPAY_SECRET_KEY` | Server-side LunarPay key (`lp_sk_…`). |
| `LUNARPAY_PUBLISHABLE_KEY` | Client-side LunarPay key (`lp_pk_…`). |
| `NEXT_PUBLIC_APP_URL` | Public URL for building hosted-checkout redirects + payment links. |
| `NEXT_PUBLIC_FORTIS_ELEMENTS_URL` | Fortis Elements SDK URL. Confirm with LunarPay/Fortis. |
| `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` | Used by `npm run db:seed`. |

## Project layout

```
src/
  app/
    admin/                  Super admin pages
    clinic/                 Clinic workspace (tenant)
    login/                  Sign-in
    pay/                    Public customer-facing payment pages
    api/
      admin/                Clinic create, impersonate start/stop
      clinic/               Customer/charge/subscription/invoice CRUD
      public/save-card/     Customer-driven card-save flow
      auth/                 NextAuth route
  components/               Shared UI primitives (AppShell, copy-button, etc.)
  lib/
    lunarpay.ts             LunarPay REST client (all endpoints)
    auth.ts                 NextAuth config + impersonation JWT handling
    session.ts              requireSession / requireSuperAdmin / requireClinicContext
    api-guard.ts            requireClinicApi() for route handlers
    prisma.ts               Prisma singleton
    audit.ts                Audit log writer
    format.ts               Money / date helpers
prisma/
  schema.prisma             DB schema (Clinic, User, Customer, …)
  seed.ts                   Creates the first super admin
```

## Scripts

- `npm run dev` — start Next.js in dev mode.
- `npm run build` — production build (also runs `prisma generate`).
- `npm run start` — run the production build.
- `npm run db:push` — sync `schema.prisma` to the DB (dev only).
- `npm run db:migrate` — create/apply migrations.
- `npm run db:seed` — create the initial super admin.
- `npm run db:studio` — open Prisma Studio.

## Production checklist

Before going live, consult [`FUTURE_SCOPE.md`](./FUTURE_SCOPE.md) — especially
the HIPAA + AWS sections. At minimum:

1. Switch `DATABASE_URL` to a managed Postgres (RDS) and enable encryption
   at rest.
2. Generate a strong `NEXTAUTH_SECRET`.
3. Add webhook handler for LunarPay events (`checkout.session.completed`,
   subscription cycles, ACH settlement) — stubbed in `FUTURE_SCOPE.md`.
4. Add rate-limits on public `/api/public/*` endpoints.
5. Set up structured audit log export (CloudTrail / Datadog).
6. Decide HIPAA posture (BAA with AWS; no PHI in LunarPay descriptions).
