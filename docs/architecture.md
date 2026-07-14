# Architecture

RevOS is a single Next.js 15 (App Router) application. There is no separate
backend service — server logic lives in **route handlers** (`src/app/api/**`)
and **server components** (`src/app/**/page.tsx`), both calling into shared
modules in `src/lib/`. State persists in PostgreSQL via Prisma. All payment
side effects go through one shared LunarPay merchant.

## System context

```mermaid
graph LR
    subgraph Clients
      SA[Super Admin<br/>browser]
      CA[Clinic Admin<br/>browser]
      CUST[Customer<br/>public pay pages]
    end

    subgraph RevOS["RevOS (Next.js on Vercel)"]
      PAGES[Server components<br/>src/app/**/page.tsx]
      APIR[Route handlers<br/>src/app/api/**]
      LIB[src/lib/*<br/>business logic]
      CRON[Cron route<br/>reconcile-subscriptions]
    end

    DB[(PostgreSQL<br/>Supabase / Prisma)]
    LP[LunarPay API<br/>single merchant]
    FORTIS[Fortis Elements<br/>card tokenization]
    IB[LookinBody / InBody<br/>Web API]
    ZAP[Failed-payment<br/>webhook e.g. Zapier]

    SA --> PAGES
    CA --> PAGES
    CUST --> PAGES
    PAGES --> LIB
    APIR --> LIB
    CRON --> LIB
    LIB --> DB
    LIB --> LP
    CUST -. card data .-> FORTIS
    FORTIS -. tokenizeId .-> CUST
    LP --> APIR
    IB --> APIR
    LIB --> IB
    LIB --> ZAP
    LP -. webhooks .-> APIR
```

Key point: **card data flows customer → Fortis directly** (dashed). RevOS only
ever receives a `tokenizeId`, which it exchanges with LunarPay for a reusable
`paymentMethodId`. See [`payments.md`](./payments.md).

## Layered module map

```mermaid
graph TD
    subgraph UI["src/app (App Router)"]
      L1[login]
      ADMIN["/admin/* — super admin<br/>layout: requireSuperAdmin"]
      CLINIC["/clinic/* — clinic workspace<br/>layout: requireClinicContext"]
      PAY["/pay/* — public token pages"]
      API["/api/* — route handlers"]
    end

    subgraph COMP["src/components"]
      SHELL[app-shell + sidebar-nav]
      WIDGETS[copy-button, download-csv-button, icon]
    end

    subgraph LIB["src/lib"]
      AUTHL[auth / session / api-guard / route-params]
      PAYL[lunarpay / master-link / subscription-reconcile / failed-charge / notify / fees]
      REPL[reporting / implementor]
      IBL[inbody / inbody-ingest / inbody-display]
      UTIL[prisma / audit / csv / format / phone / validators]
    end

    DB[(Prisma → Postgres)]

    ADMIN --> SHELL
    CLINIC --> SHELL
    ADMIN --> AUTHL
    CLINIC --> AUTHL
    API --> AUTHL
    API --> PAYL
    API --> IBL
    ADMIN --> REPL
    PAYL --> DB
    REPL --> DB
    IBL --> DB
    AUTHL --> DB
    UTIL --> DB
    PAYL --> UTIL
    REPL --> UTIL
    IBL --> UTIL
```

## Request lifecycle

### Authenticated page (server component)

```mermaid
sequenceDiagram
    participant B as Browser
    participant P as Page (server component)
    participant G as session.ts guard
    participant DB as Prisma
    B->>P: GET /clinic/customers
    P->>G: requireClinicContext()
    G-->>P: {session, clinicId} (or redirect /login|/admin)
    P->>DB: query scoped by clinicId
    DB-->>P: rows
    P-->>B: rendered HTML
```

### Mutating API call (route handler)

```mermaid
sequenceDiagram
    participant B as Browser (client component)
    participant R as Route handler
    participant G as api-guard.ts
    participant Z as Zod
    participant LP as LunarPay
    participant DB as Prisma
    participant A as audit.ts
    B->>R: POST /api/clinic/customers/:id/charges
    R->>G: requireClinicApi() (or requireSuperAdminClinicApi)
    G-->>R: {session, clinicId} | 401/403
    R->>Z: validate body
    R->>LP: createCharge(...)  (cents, [Clinic] prefix)
    LP-->>R: charge result | LunarPayError
    R->>DB: persist mirror Charge row
    R->>A: logAudit("charge.create")
    R-->>B: JSON result
```

### Inbound webhook (LunarPay / InBody)

```mermaid
sequenceDiagram
    participant EXT as LunarPay / LookinBody
    participant W as /api/webhooks/*
    participant V as Verify signature/secret
    participant DB as Prisma
    EXT->>W: POST event
    W->>V: HMAC (LunarPay) / secret+account header (InBody)
    V-->>W: ok | 401
    W->>DB: idempotent upsert (deterministic id / dedupeKey)
    W-->>EXT: 200 (even on internal error, to stop retries)
```

## Multi-tenancy model

RevOS owns the `Customer → Clinic` mapping itself; LunarPay has no clinic
concept. Every tenant-scoped table carries a nullable `clinicId`. Scoping is
enforced in application code (the guards resolve an `effectiveClinicId`), not
yet by Postgres row-level security (see `FUTURE_SCOPE.md` §8).

```mermaid
graph TD
    RevOS[RevOS super admin] -->|creates| Clinic
    RevOS -.impersonates.-> Clinic
    Clinic -->|has many| ClinicAdmin[User: CLINIC_ADMIN]
    Clinic -->|has many| Customer
    Customer -->|has many| PaymentMethod
    Customer -->|has many| Charge
    Customer -->|has many| Subscription
    Customer -->|has many| PaymentSchedule
    LPM[Single LunarPay merchant] -->|shared by| Clinic
```

The `[Clinic Name]` prefix on every LunarPay charge description keeps the shared
merchant dashboard auditable per clinic.

## Where things run

- **Runtime data plane**: pooled Supabase Postgres URL (`DATABASE_URL`, port
  6543). Prisma migrations use the direct URL (`DIRECT_URL`, port 5432).
- **Cron**: `vercel.json` schedules `GET /api/cron/reconcile-subscriptions`
  nightly at `0 8 * * *` (UTC). It requires a `CRON_SECRET` bearer token.
- **Deploy**: Vercel (`vercel.json`, `next build` runs `prisma generate`).

Continue to [`data-model.md`](./data-model.md) for the persistence layer.
