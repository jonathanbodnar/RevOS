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
   never clobbers a **manual** customer mapping or previously fetched metrics
   when a later API request fails.

Other functions:
- `refetchInBodyTest(id)` — re-attempts auto-pair only if still unmatched; refetches metrics.
- `syncInBodyMeasurementsForDate(date?)` — pulls a day's measurements via
  `GetTodayMeasurements` and pipes each through the ingest path.
- `backfillInBodyTests(limit?)` — re-fetches historical rows that still lack
  metrics and re-runs eligible phone auto-matching.

## API client (`inbody.ts`)

- Config: `INBODY_API_BASE` (default `https://apiusa.lookinbody.com`),
  `INBODY_API_KEY`, `INBODY_ACCOUNT`. `inbodyConfigured()`/`inbodyCanFetch()`
  require both values.
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

## Admin routes (`api/admin/inbody/*`, guard `requireSuperAdminApi`)

| Route | Purpose |
| --- | --- |
| `POST connection-test` | Verify InBody credentials (`/user/test`). |
| `POST sync-today {date?}` | Pull a day's measurements (needs elevated InBody permissions). |
| `POST backfill {limit?}` | Re-fetch historical rows without metrics (1–500, default 200). |
| `POST tests/[id]/map {customerId}` | Map (or unmap with null) a test to a customer → `matchStatus="manual"`. |
| `POST tests/[id]/refetch` | Re-fetch a test's results. |

## Admin UI (`src/app/admin/inbody/*`)

`page.tsx` lists up to 200 tests (optional `?filter=unmatched`), shows counts +
API-key status, and computes the webhook URL. `inbody-client.tsx` renders the
webhook-setup card (copyable URL), connection test, "pull today", historical
backfill, and a test table with details (via `inbody-display.ts` formatters),
map/unmap, and refetch. Manual customer search normalizes formatted phone
numbers before matching.

## Status fields (`InBodyTest`)

- `resultStatus`: `pending` | `fetched` | `matched_no_data` | `unmatched` | `error`.
- `matchStatus`: `unmatched` | `auto` | `manual` | `ambiguous`.

## Data-access status

InBody approved the account's data-API access on 2026-07-14. Production must
have both `INBODY_API_KEY` and `INBODY_ACCOUNT`; after deployment, run
**Backfill existing tests** to populate scans received before approval.
