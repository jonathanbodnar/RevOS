# Call center: importing leads

Importing is how a clinic's leads reach the call center, and it starts
everything else. A clinic's leads come in three ways:

- RevOS staff upload an Excel or CSV file on the clinic's **Import** tab.
- The clinic uses its **connect link**, one page with no login. From there it
  can connect its CRM or upload a spreadsheet itself.
- A connected CRM is synced (**Sync now**).

All three paths go through the same server code (`importRows` in
`src/lib/call-center/import-server.ts`), so dedupe and lead setup are
identical everywhere.

## The flow, as the UI shows it

### Import tab (`/call-center/[clinicId]/import`)

Super admins can use this tab, and so can call agents who have access to the
clinic (`requireCallCenterClinicPage`).

1. **Choose file.** Drop or pick an `.xlsx` or `.csv` file (`.txt` and `.tsv`
   also work). The page reads the file in the browser. The file itself is
   never uploaded.
2. **Sheet and header row.** A workbook with several sheets opens on the
   sheet with the most rows; pick another from **Sheet**. **Header row** lists
   the first 25 rows. It is guessed (title rows above the headers are
   skipped) and can be changed.
3. **Columns.** Each field has a column picker, and each pick shows a sample
   value from that column. The pickers are filled in automatically using the
   Dial Desk's guesses. The fields are:
   - phone (required)
   - full name (split into first and last), first name, last name
   - email
   - status
   - last called
   - appointment (date and time)
   - notes
   - priority
   - agreed to calls (consent)
   - CRM id
   - lead source
4. **Priority.** If a priority column is picked, choose one of two rules:
   - "Anyone with Yes, X or any other value". Values like No, Low or blank
     don't count.
   - "Anyone whose value contains ___". This is the Dial Desk's priority text,
     for example GLP-1 or Tirzepatide. The most common values in the column
     can be clicked to fill it in.

   A Segment or Tags column starts on the "contains" rule. Until text is
   entered, nobody is marked priority.
5. **Preview.** The first 10 rows exactly as they will be imported. A row with
   no usable phone says so.
6. **Statuses.** Every distinct status in the file, with its row count and the
   desk stage it maps to. The stage is guessed with the Dial Desk's rules and
   can be changed per status, including "(blank)".
7. **Options.**
   - "These people agreed in writing to be called". Tick this only if it's
     true for everyone in the file.
   - "Update statuses from this file".
8. **Import N leads.** Shows a progress bar and sends 500 rows per request.
   The result counts are:
   - **Added**
   - **Updated**
   - **Unchanged**: nothing new, or a repeat within the file
   - **No usable phone**
   - **Already patients**

Below the import are three more sections:

- **Past imports**: the last 20, with counts.
- **Clinic CRM**: one card each for Zenoti, Mindbody and Aesthetic Record,
  with Connect, Sync now and Disconnect.
- **Clinic link**: make, copy or turn off the link.

### Clinic connect link (`/connect/<token>`)

This page is RevOS-branded and shows the clinic's name. It has no app shell
and needs no login. It is marked `noindex`.

- **Connect your CRM.** The same three cards. After a CRM connects, the page
  pulls the leads straight away.
- **Upload a spreadsheet.** The same import flow, simplified:
  - Columns are matched automatically. **Fix columns** opens the pickers and
    the header row choice.
  - There is no status table. Statuses are guessed on the server.
  - "Update statuses" is never applied.
  - The clinic can still tick the consent box.
- **What the page shows back.** Only what came from the clinic itself: leads
  sent, rows with no usable phone, and records pulled from the CRM. It never
  shows added, updated or already-a-patient counts, because those would let
  anyone holding the link upload one phone number and learn whether that
  person is a lead or patient of the clinic. The page shows no lead or
  patient data at all.
- **Bad links.** A link that is revoked, expired, made up, or belongs to an
  inactive clinic shows: "This link has expired. Ask your RevOS contact for a
  new one."

## What happens to each row

The browser runs `src/lib/call-center/import.ts`, which is isomorphic.

- **CSV parsing.** Quoted fields, doubled quotes, line breaks inside quotes,
  CRLF, LF and CR line endings, and a BOM. The delimiter is detected from the
  first rows: comma, semicolon (European Excel) or tab. The text encoding
  falls back from UTF-8 to Windows-1252, which is Excel's plain CSV on
  Windows. UTF-16 (Excel "Unicode text") is detected by its BOM.
- **Excel parsing.** Uses `read-excel-file`. Numbers come back as their exact
  text, so long ids and phones stored as numbers keep every digit. Date cells
  come back as wall-clock times with no time zone.
- **Phone.** Run through `normalizePhone`. Extensions are dropped ("x12"). In
  "555-0100 / 555-0101" the first usable number wins. A row without exactly
  10 digits is **invalid** and isn't sent.
- **Blank rows** are skipped and not counted.
- **Repeats within the file** are merged into the first row with that phone:
  - The first row's values win.
  - Its blanks are filled from the later row.
  - Notes are combined.
  - Priority or consent on either row counts.
  - The repeat is counted as Unchanged.
- **Dates.** US style (11/13/2026, 11/3/26 2:30 PM), ISO, month names
  ("Nov 13, 2026"), 13-Nov-2026, Excel date cells and Excel serial numbers. A
  date with no time is read as noon. Dates are sent as clinic wall time and
  converted with the clinic's time zone on the server.
- **Consent.** Yes, true, X or a date in the consent column means agreed. A
  date is used as the consent date. Columns are only guessed as consent when
  their title says consent or TCPA. An SMS or email opt-in isn't permission to
  call with a dialer, so a person has to map those.
- **Lead source.** Lead has no marketing-source field. The source is saved as
  the first line of the note ("Source: Facebook"). `Lead.source` keeps the
  channel: csv, xlsx, zenoti, mindbody or aesthetic_record.

The server re-checks every row with `ImportRowSchema` before writing. That
means real calendar dates, length caps, a strict shape, and exactly 10 digits
in the phone.

### New leads

New leads start the way the Dial Desk's `makeContact` did. "Today" is the
clinic-local day, using `loadRules()` and `time.ts`.

| Stage from the file | Starts with |
| --- | --- |
| No answer (`cycle`) | `attempts` 1, and `nextDueDay` set to `spacingDays` work days after the last call, never before today. With no last call, today. |
| Call back (`nurture`), Rebook (`resched`) | `nextDueDay` today |
| Lost | `lostReason` "From sheet" |
| no status, future appointment | Booked |
| anything else | as mapped (New by default) |

Every new lead also gets:

- `lastCalledAt` at noon clinic time on the last-called day. A last-called day
  in the future counts as today.
- `apptAt` from the appointment.
- `lastNote`, encrypted.
- `sourceStatus` set to the clinic's own status text.
- `externalId`, `importId` and `source`.
- `createdAt` set to the import start plus the row's position in ms, so leads
  keep the file's order.
- `consentAt`/`consentSource` when the row has consent or the box was ticked.
  `consentSource` is `import:<file name>` or `import:<provider>`. A consent
  date in the future counts as now.

Each new lead gets a `LeadActivity` with kind `import`, outcome `imported`
and the encrypted note.

### Leads the clinic already has (same phone)

Only blanks are filled: name, email and CRM id. Beyond that:

- **Priority** follows the file only when the file has a priority column.
- **Consent** is added only if the lead has none. An import never removes
  consent.
- **Notes** are appended only if the lead's note doesn't already contain
  them. The note is capped at 4,000 characters, keeping the newest text. A
  note that can't be decrypted is left alone.
- **Stage** changes only when "Update statuses from this file" is ticked AND
  the lead has no desk activity. Desk activity means any `LeadActivity` that
  isn't from an import. The desk's own work is never overwritten.
- **"Do not call" is the exception.** A file that says "Do not call" moves
  the lead to `dnc` even if the desk has worked it. Only the stage changes;
  the desk's counters are kept. An import never moves a lead out of `dnc`.

A status change adds a `LeadActivity` with outcome `status`. An appended note
adds one with outcome `imported`.

### Current patients

Patients are matched to `Customer` rows in the same clinic. The phone is
compared on its last 10 digits, the same way as InBody pairing, so a
formatted `Customer.phone` still matches.

- If exactly one patient matches, the lead is linked (`customerId`). When two
  patients share a phone, it counts as a patient but neither is linked.
- A new lead that matches starts as **Showed**, so the desk never cold-calls
  a current patient.
- An existing lead that matches and is still New moves to Showed, but only if
  the desk hasn't worked it.
- Matches are counted as "Already patients".

## Limits

| Limit | Value | Where |
| --- | --- | --- |
| File size | 20 MB | browser |
| Leads per import | 50,000 (after repeats are merged) | browser and server |
| Rows per request | 500 | server (`CHUNK_SIZE`) |
| Request body | 3 MB, cut off while it streams | server (`readJsonBody`) |
| Note per row | 2,000 characters; lead note 4,000 | both |
| Link lifetime | 30 days by default (7, 30 or 90 to choose; 1 to 90 accepted). One live link per clinic; a new link turns the old one off. | `connect-link.ts` |
| Link requests | 600 per 10 min per IP address. 240 uploads or syncs per 10 min per link and IP. 20 connect attempts per 10 min per link and IP. | in memory, per instance |
| CRM sync | 500 leads per request. The browser keeps calling until the CRM is done, up to 50,000 per sync. | `integrations.ts` |

## When things go wrong

| What happens | What the person sees |
| --- | --- |
| Old `.xls`, `.numbers`, broken `.xlsx`, empty file or file over 20 MB | A plain message saying how to re-save the file. Nothing is sent. |
| Phone column not picked | "Pick the column with phone numbers." Import stays disabled. |
| Connection drops or a chunk fails mid-import | "… of N leads were saved", with **Try again**, which resumes from that chunk. The import's status is `failed` until the retry succeeds. Rows already saved are deduped by phone, so a retry is safe. |
| Page closed mid-import | The browser warns first. In history the import shows as "Didn't finish" after 30 minutes. |
| Link revoked or expired while in use | The expired message. |
| Too many requests | "Too many tries. Wait a few minutes and try again." (429) |
| CRM rejects a key, is busy, or is down | A short message on the card, saved in `ClinicIntegration.lastError`. A rejected key sets the status to `error` ("Needs attention"). Vendor responses and secrets are never stored or shown. |

## CRM connectors (`src/lib/crm/`)

Every adapter implements `CrmAdapter` (`types.ts`):

- `provider` and `label`
- `connectFields`
- `unavailableReason()`
- `connect(input, pending)`, which returns connected credentials or a next
  step: pick from a list, owner approval, or request noted
- `fetchLeads(credentials, { since, limit, cursor })`, which returns lead
  records plus a cursor

`integrations.ts` stores credentials with
`encryptField(JSON.stringify(...))`. In production it refuses to store them
if `FIELD_ENCRYPTION_KEY` is unset. Credentials are never sent to a browser;
`IntegrationView` is all a page gets.

**Sync now** is chunked like a file import:

- The first request starts a `LeadImport` with `source` set to the provider.
  It asks for leads changed since the last finished sync, with a day of
  overlap.
- Each later request sends back the `importId` and the cursor.
- When done, `lastSyncAt` is set to the sync's start time.

CRM rows never change existing leads' stages, apart from "Do not call". The
UI says "Connect", never "OAuth": none of these vendors offers a business
OAuth flow.

| CRM | What it does today | Verified? |
| --- | --- | --- |
| **Zenoti** | The clinic pastes an API key. RevOS lists centers to check it, and the clinic picks one if there are several. Sync pages through `GET /v1/guests` for that center. | Built from docs.zenoti.com only. It has not run against a live Zenoti account; that needs a clinic's API key. |
| **Mindbody** | The clinic enters its Site ID, the owner approves RevOS, and the clinic clicks **I approved it**. Sync pages `GET /client/clients` using a staff token. | Built from the Public API v6 docs only. RevOS has no Mindbody developer account yet, so the card says "Mindbody isn't available yet". |
| **Aesthetic Record** | **I want this connected** records a pending request. The card also gives the steps to export the client list to Excel and upload it. | Nothing to verify: no endpoints are called. |

### Zenoti (built to docs.zenoti.com)

**Clinic setup:**

1. In Zenoti, go to Configuration, then Integrations, then Apps, and click
   **Add**.
2. Create a backend app with read access to guests and centers.
3. Click **Generate API Key** and paste the key on the card.

**Requests:**

- Base URL: `https://api.zenoti.com/v1`. Regional hosts aren't documented.
- Auth header: `Authorization: apikey <key>`.
- `GET /v1/centers` checks the key and lists centers.
- `GET /v1/guests?center_id&page&size=100[&last_updated=YYYY-MM-DD]` pulls
  guests, at most 100 a page.
- Each guest is mapped as:
  - `personal_info.first_name` and `last_name`
  - `email`
  - `mobile_phone.number`, then home phone, then work phone
  - `id` as `externalId`
  - `referral.referral_source.name` as the lead source

**Rate limit:** 60 calls a minute per Zenoti account, shared with the
clinic's other apps. Calls are spaced 1.1 s apart, and a 429 is retried once
after `Retry-After`.

**Not built:**

- Zenoti's **Opportunities** (sales pipeline) API, `GET /v1/opportunities`.
  It would give lead stages, but its center parameter name isn't consistent
  in the docs.
- Telling leads from guests (`user_type` 4). It isn't confirmed that list
  responses return it.
- Zenoti has no do-not-call field. Its marketing-SMS opt-in isn't call
  consent, so it isn't mapped.

**Key expiry:** Zenoti's docs conflict ("valid for one year" vs "don't
expire"). A rotated key stops working within a week. If that happens, the
card shows "Needs attention" and the clinic pastes the new key.

### Mindbody (built to the Public API v6 docs)

**Configuration:** needs RevOS's own developer account (the env vars below).
Without them the card says Mindbody isn't available yet, and nothing is
called.

**Requests:**

1. The Site ID goes to `GET /site/activationcode`, sent with `Api-Key` and
   `SiteId` headers. It returns `ActivationLink` and `ActivationCode`. The
   owner opens the link and logs in, or enters the code under Manager Tools,
   then Mindbody Add Ons, then API Integrations.
2. **I approved it.**
   - `POST /usertoken/issue` with the integration's auto-created staff login.
     That login is `_` plus the source name, with the source password, so no
     clinic password is ever asked for or stored.
   - Then one `GET /client/clients?request.limit=1` read.
   - Then `GET /site/sites` for the site name.
3. **Sync.**
   - `GET /client/clients`, 200 a page, using `request.offset` and
     `request.lastModifiedDate`.
   - It sends `Authorization: Bearer <token>`.
   - Mobile phone is tried first, then home, then work.
   - A prospect's `ProspectStage.Description` (or "Prospect") becomes the
     status. Members carry their membership `Status`.
   - `UniqueId` becomes `externalId`.

**Pricing:** $0.002 per call above 5,000 calls a month. An older FAQ says
1,000 calls a day; confirm which applies when RevOS requests live access.

**Before turning it on:** Mindbody's API Terms of Use (§8) forbid caching
Mindbody data for more than 48 hours, including personal data. Keeping a
spa's clients as leads conflicts with that. Get Mindbody's written OK, or a
legal read, before adding the keys.

**Unverified:**

- Whether the `_SourceName` staff login may list all clients.
- Whether `lastModifiedDate` uses the site's local time.

### Aesthetic Record (honest stub)

- **No read API.** Aesthetic Record has no public API. What it documents is a
  Leads API for pushing leads *into* Aesthetic Record. Keys for it are issued
  to approved partners (partnerships@aestheticrecord.com) or by its support.
  So RevOS records the request (status `pending`) and tells the clinic to ask
  Aesthetic Record support for an API key for RevOS.
- **Meanwhile, export to Excel:**
  1. In Aesthetic Record, open **Clients** (or **Patients**).
  2. Click **+** and pick the columns.
  3. Click **Import/Export**, then **Export as Excel**.
  4. Upload the file here.
- **A possible later path:** Aesthetic Record's Zapier app has a "New Patient"
  trigger (paid Zapier plan) that could post new patients to a RevOS webhook.
  It isn't built.

## Privacy and audit

- **The file stays in the browser.** Only normalized rows are sent.
- **Encryption at rest:**
  - Lead notes and import-activity notes use `encryptField`.
  - CRM credentials are stored as one encrypted JSON string.
  - The link token is stored as a sha256 for lookup plus an encrypted copy,
    so staff can copy the link again. If `FIELD_ENCRYPTION_KEY` changes, the
    old link can't be shown; make a new one.
- **`LeadImport.mapping`** keeps only column titles and up to 40 short status
  labels, never row data.
- **Audit rows.** `logAudit` records ids and counts only, never names, phones
  or notes. Clinic-link actions are logged with `actorRole` `CLINIC_LINK`,
  `via: "clinic_link"` and the `linkId`. The actions are:
  - `lead_import.start`
  - `lead_import.finish`
  - `crm.connect`
  - `crm.connect_step`
  - `crm.disconnect`
  - `connect_link.create`
  - `connect_link.revoke`
- **Clinic-link uploads can change existing leads.** A clinic-link upload can
  fill blanks, append notes, add consent and mark Do not call on the clinic's
  existing leads. It is still the clinic's own data, and the clinic attests
  to it. Every change is traceable to the import and the link.

## Environment

| Var | Purpose |
| --- | --- |
| `MINDBODY_API_KEY` | RevOS's Mindbody developer API key (`Api-Key` header). |
| `MINDBODY_SOURCE_NAME` | The developer account's source name. The staff login is `_` plus this name. |
| `MINDBODY_SOURCE_PASSWORD` | The source password. |
| `NEXT_PUBLIC_APP_URL` | Already exists. Used to build connect-link URLs; falls back to the request host. |
| `FIELD_ENCRYPTION_KEY` | Already exists. Required in production to store CRM keys. |

Zenoti and Aesthetic Record need no RevOS env vars. The clinic's Zenoti key
is stored per clinic.

## Dependency

`read-excel-file` 9.3.14 (MIT) reads `.xlsx` in the browser.

- It is loaded only when an Excel file is picked, as a lazy chunk of about
  14 KB gzipped.
- It was picked over the `xlsx` package, which is stale and has known CVEs,
  and over `exceljs`, which is large and was last published in 2024.
- Two of its dependencies are pinned in `package.json` `overrides` to
  releases that are at least two weeks old: `worker-f` 0.1.21 and
  `graceful-fs` 4.2.11. When upgrading `read-excel-file`, re-check those
  pins.
- Its unzipper (fflate) may start a Web Worker from a `blob:` URL. If a
  Content-Security-Policy is ever added, allow `worker-src blob:`.

## Files

| Path | What |
| --- | --- |
| `src/lib/call-center/import.ts` | Parsing, guessing, normalizing (isomorphic) |
| `src/lib/call-center/import-server.ts` | `importRows`, chunked import requests, history |
| `src/lib/call-center/connect-link.ts` | Link tokens, lookup, rate limits, public-route guard |
| `src/lib/crm/*` | Adapters, HTTP helper, server-side connections and sync |
| `src/components/call-center/*` | Import flow, file reader, CRM cards, link card, history |
| `src/app/call-center/[clinicId]/import/page.tsx` | Import tab |
| `src/app/connect/[token]/page.tsx` | Clinic connect page |
| `src/app/api/call-center/[clinicId]/{imports,integrations,connect-links}/…` | Staff API (`requireCallCenterApi`) |
| `src/app/api/public/connect/[token]/…` | Clinic-link API (token guard) |

### API

| Method | Path | Guard | Purpose |
| --- | --- | --- | --- |
| GET / POST | `/api/call-center/[clinicId]/imports` | `requireCallCenterApi` | Recent imports / one import chunk |
| GET | `/api/call-center/[clinicId]/integrations` | `requireCallCenterApi` | CRM connection status |
| POST / DELETE | `/api/call-center/[clinicId]/integrations/[provider]` | `requireCallCenterApi` | Connect step / disconnect |
| POST | `/api/call-center/[clinicId]/integrations/[provider]/sync` | `requireCallCenterApi` | One sync batch |
| GET / POST | `/api/call-center/[clinicId]/connect-links` | `requireCallCenterApi` | List / make the link |
| DELETE | `/api/call-center/[clinicId]/connect-links/[linkId]` | `requireCallCenterApi` | Turn a link off |
| POST | `/api/public/connect/[token]/imports` | Token + rate limit | Clinic upload chunk (counts back) |
| POST | `/api/public/connect/[token]/integrations/[provider]` | Token + rate limit | Clinic connect step |
| POST | `/api/public/connect/[token]/integrations/[provider]/sync` | Token + rate limit | Clinic sync batch (counts back) |
