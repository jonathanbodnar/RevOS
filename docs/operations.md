# Operations

Setup, environment, scheduled jobs, deploy, and security caveats.

## Local setup

```bash
npm install
cp .env.example .env          # fill in secrets (see below)
npm run db:push               # sync schema.prisma → DB (dev)
npm run db:seed               # create the first super admin
npm run dev                   # http://localhost:3000/login
```

Default seeded credentials come from `SUPER_ADMIN_EMAIL` /
`SUPER_ADMIN_PASSWORD` (default `admin@revos.local` / `ChangeMe123!`).

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Next.js dev server. |
| `npm run build` | `prisma generate && next build`. |
| `npm run start` | Run the production build (`-p $PORT`). |
| `npm run db:push` | Push schema to DB, no migration file (dev). |
| `npm run db:migrate` | Create/apply a migration (uses `DIRECT_URL`). |
| `npm run db:seed` | Seed super admin (`tsx prisma/seed.ts`). |
| `npm run db:studio` | Prisma Studio. |
| `npm run lint` | Next.js lint. |
| `node scripts/e2e-smoke.mjs` | End-to-end smoke script. |

## Environment variables (`.env.example`)

| Var | Purpose |
| --- | --- |
| `DATABASE_URL` | Runtime Postgres (Supabase pooler, port 6543, `pgbouncer=true`). |
| `DIRECT_URL` | Direct Postgres (port 5432) for Prisma migrations. |
| `NEXTAUTH_URL` | Base URL for NextAuth. |
| `NEXTAUTH_SECRET` | JWT signing key (`openssl rand -base64 32`). |
| `LUNARPAY_BASE_URL` | LunarPay API base (`https://app.lunarpay.com`). |
| `LUNARPAY_SECRET_KEY` | Server-side LunarPay key (`lp_sk_…`). |
| `LUNARPAY_PUBLISHABLE_KEY` | Client-side key (`lp_pk_…`) for tokenization intentions. |
| `LUNARPAY_WEBHOOK_SECRET` | Verify inbound LunarPay webhook HMAC (optional). |
| `FAILED_PAYMENT_WEBHOOK_URL` | Outbound webhook on payment failure (e.g. Zapier, optional). |
| `INBODY_API_KEY` | LookinBody Web API key. |
| `INBODY_ACCOUNT` | LookinBody account name (e.g. `revosinbody2`). |
| `INBODY_API_BASE` | InBody Web API base (`https://apiusa.lookinbody.com`). |
| `INBODY_WEBHOOK_SECRET` | Verify inbound InBody webhook header. **Required** — the webhook route fails closed (503, deliveries dropped) when unset. |
| `NEXT_PUBLIC_APP_URL` | Public URL for checkout redirects + payment links. |
| `NEXT_PUBLIC_FORTIS_ELEMENTS_URL` | Fortis Elements JS SDK URL. |
| `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` | Seed credentials. |
| `CRON_SECRET` | Bearer token required by the reconciliation cron (route is disabled if unset). |

`.env` is git-ignored. Never print, commit, or echo it.

## Scheduled jobs

The app runs on **Railway**, which ignores `vercel.json` crons (that file is
legacy). The nightly reconciliation is scheduled by GitHub Actions —
`.github/workflows/reconcile-cron.yml` calls
`GET https://revosportal.com/api/cron/reconcile-subscriptions` at 08:00 UTC
using the `CRON_SECRET` repository secret (must match the Railway env var).

The route requires `Authorization: Bearer $CRON_SECRET`; if `CRON_SECRET` is
unset it returns 503 (disabled) rather than exposing an unauthenticated write.
See [`payments.md`](./payments.md#reconciliation) for what it does.

## Deploy (Railway)

- Project `ample-solace`: `production` env deploys branch `main` and serves
  revosportal.com; `Dev` deploys branch `dev` and serves dev.revosportal.com.
- `next build` runs `prisma generate` first (see `package.json`).
- Set all env vars in the Railway environment. Use the Supabase **pooler**
  URL for `DATABASE_URL`.
- Register webhook endpoints in LunarPay and LookinBody pointing at
  `/api/webhooks/lunarpay` and `/api/webhooks/inbody` (or the `/webhooks/*`
  aliases).

## Security caveats (address before production)

- **Remove debug endpoints**: `/api/health/login-check` (unauthenticated bcrypt
  check, marked "REMOVE BEFORE PRODUCTION USE") and
  `/api/debug/lunarpay-intentions` (explicitly no auth).
- Rotate `NEXTAUTH_SECRET`, `SUPER_ADMIN_PASSWORD`, and all API keys away from
  the example values.
- Set `LUNARPAY_WEBHOOK_SECRET` and `INBODY_WEBHOOK_SECRET` so inbound webhooks
  are verified.
- Tenant scoping is enforced in app code, not Postgres RLS — see
  `FUTURE_SCOPE.md` §8/§9 for the HIPAA/RLS hardening roadmap.
- Admin `/api/admin/*` routes use inline super-admin checks; prefer the
  `requireSuperAdminApi` helper for new routes for consistency.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Recurring charges missing from reports | Lost LunarPay webhook; run reconciliation (`/api/admin/lunarpay/reconcile-subscriptions` or wait for cron). |
| InBody scans show no metrics | Confirm both InBody env vars, run the connection test, then run **Backfill existing tests** and inspect the per-test fetch error. |
| Card add fails silently | Check `NEXT_PUBLIC_FORTIS_ELEMENTS_URL` and the publishable key on the intention. |
| Cron returns 503 | `CRON_SECRET` not set. |
