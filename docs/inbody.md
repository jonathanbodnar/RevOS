# InBody Integration

RevOS ingests body-composition scans from **LookinBody Web** (the InBody cloud)
and auto-pairs each scan to a RevOS `Customer` by phone number.

Core files: `src/lib/inbody.ts`, `src/lib/inbody-ingest.ts`,
`src/lib/inbody-display.ts`, `src/app/api/webhooks/inbody/route.ts`,
`src/app/api/admin/inbody/*`, `src/app/admin/inbody/*`. Model: `InBodyTest`.

## Data flow

```mermaid
sequenceDiagram
    participant DEV as InBody device
    participant LB as LookinBody Web
    participant RV as RevOS /api/webhooks/inbody
    participant API as InBody Web API
    participant DB as Prisma

    DEV->>LB: scan uploaded
    LB->>RV: POST notification (Account, phone, TestDatetimes, ...)
    RV->>RV: verify secret + Account; normalize phone (last 10)
    RV->>API: fetch full results by phone (UserToken) + datetimes
    API-->>RV: body-composition metrics
    RV->>DB: find customer by normalized phone → auto/ambiguous/unmatched
    RV->>DB: upsert InBodyTest on dedupeKey (idempotent)
    RV-->>LB: 200 {success, matched}
```

## Ingestion (`inbody-ingest.ts`)

`ingestInBodyNotification(payload)`:
1. Extract `Account`, `EquipSerial`, `Equip`, `Type`, `UserID`, `TelHP` (phone),
   `TestDatetimes`, `IsTempData`.
2. `phoneNormalized = normalizePhone(TelHP)` (last-10-digit form).
3. `dedupeKey = account:equipSerial:inbodyUserId:rawDatetimes`.
4. **Auto-pair by phone** via SQL `right(regexp_replace(phone,'\D','','g'),10)`:
   - exactly **1** match → `matchStatus="auto"` (sets `customerId` + `clinicId`);
   - **>1** → `"ambiguous"` (not linked, flagged for manual mapping);
   - **0** → `"unmatched"`.
5. If configured, fetch metrics (`fetchInBodyResults`); also normalize any inline
   webhook metrics as a fallback. Sets `resultStatus` to `fetched` /
   `matched_no_data` / `error` / `pending` accordingly.
6. **`upsert` on `dedupeKey`** — idempotent; re-delivery refreshes metrics but
   never clobbers a **manual** customer mapping.

Other functions:
- `refetchInBodyTest(id)` — re-attempts auto-pair only if still unmatched; refetches metrics.
- `syncInBodyMeasurementsForDate(date?)` — pulls a day's measurements via
  `GetTodayMeasurements` and pipes each through the ingest path.

## API client (`inbody.ts`)

- Config: `INBODY_API_BASE` (default `https://apiusa.lookinbody.com`),
  `INBODY_API_KEY`, `INBODY_ACCOUNT`. `inbodyConfigured()`/`inbodyCanFetch()`
  return `Boolean(API_KEY)`.
- Auth headers on every call: `Account`, `API-KEY`. **Server-only** (holds the key).
- Endpoints wrapped: `/user/test` (connection test),
  `/inbody/GetDateTimes|GetDatetimesByID`, `/inbody/GetTodayMeasurements`,
  `/inbody/GetFullInBodyData(ByID)` + `/inbody/GetInBodyData(ByID)` (called in
  parallel and merged for max field coverage).
- `normalizeInBodyResult` maps many field-name aliases (case/format-insensitive)
  into `InBodyMetrics`: 7 core (`weightKg`, `totalBodyWaterKg`, `dryLeanMassKg`,
  `skeletalMuscleMassKg`, `bodyFatMassKg`, `bmi`, `percentBodyFat`) + 10
  segmental-lean (5 segments × kg + %).
- Datetime helpers: `parseTestDatetimes("yyyyMMddHHmmss")` ↔ `formatTestDatetimes`.

## Webhook receiver (`api/webhooks/inbody/route.ts`)

- Node runtime, force-dynamic.
- **Verify**: if `INBODY_WEBHOOK_SECRET` set, some incoming header value must
  equal it (else 401); if `INBODY_ACCOUNT` set, payload `Account` must match
  (case-insensitive, else 401).
- Parses JSON or form-encoded bodies; calls `ingestInBodyNotification`; returns
  200 `{success, id, matched}` (LookinBody requires a 200 body to save the
  webhook during its "Sent Test").
- `src/app/webhooks/inbody/route.ts` is a thin alias re-exporting `POST`.

## Admin routes (`api/admin/inbody/*`, guard `requireSuperAdminClinicApi`)

| Route | Purpose |
| --- | --- |
| `POST connection-test` | Verify InBody credentials (`/user/test`). |
| `POST sync-today {date?}` | Pull a day's measurements (needs elevated InBody permissions). |
| `POST tests/[id]/map {customerId}` | Map (or unmap with null) a test to a customer → `matchStatus="manual"`. |
| `POST tests/[id]/refetch` | Re-fetch a test's results. |

## Admin UI (`src/app/admin/inbody/*`)

`page.tsx` lists up to 200 tests (optional `?filter=unmatched`), shows counts +
API-key status, and computes the webhook URL. `inbody-client.tsx` renders the
webhook-setup card (copyable URL), connection test, "pull today", and a test
table with details (via `inbody-display.ts` formatters), map/unmap, and refetch.

## Status fields (`InBodyTest`)

- `resultStatus`: `pending` | `fetched` | `matched_no_data` | `unmatched` | `error`.
- `matchStatus`: `unmatched` | `auto` | `manual` | `ambiguous`.

## Known limitation

As of 2026-07-01, the InBody data endpoints (`/inbody/*`, `/user/GetUser`)
return `401` for this account even with a valid key — only `/user/test`
succeeds. The data-access add-on must be activated on the LookinBody account
(contact InBody support). Until then, notifications are stored and paired but
metrics stay empty. (Documented in `.env.example`.)
