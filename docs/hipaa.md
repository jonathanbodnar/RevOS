# HIPAA / Compliance Runbook

What's built, what to configure, and what needs your action (BAAs, backups).
Companion to the security notes in [`operations.md`](./operations.md).

## 1. Configuration (env vars)

Set these in the Railway environment. All are optional — each feature is a
no-op until its var is set — but production should set all of them.

| Var | Purpose | Notes |
| --- | --- | --- |
| `FIELD_ENCRYPTION_KEY` | Encrypts PHI free-text at rest (progress notes, payment notes, InBody raw payloads, chat logs) and the MFA secret. | 32 bytes, hex or base64: `openssl rand -hex 32`. **Never rotate without setting `FIELD_ENCRYPTION_KEY_PREVIOUS`** — old rows become unreadable. Store a backup copy outside Railway. |
| `FIELD_ENCRYPTION_KEY_PREVIOUS` | Comma-separated key(s) rotated away from. Reads fall back to these; writes always use the primary. | Required to rotate `FIELD_ENCRYPTION_KEY` without orphaning existing rows. Keep an old key here until you have re-encrypted every row under the new one. |
| `LUNARPAY_WEBHOOK_SECRET` / `INBODY_WEBHOOK_SECRET` | Webhook signature verification. | Endpoints now **fail closed** (503) when unset. |
| `CRON_SECRET` | Auth for all cron routes. | Must match the GitHub Actions repo secret. |
| `SECURITY_ALERT_WEBHOOK_URL` | Where security alerts go (Slack/on-call). | Fires on repeated login failures, impersonation start, wipe attempts, MFA disable, and an unreadable MFA secret. No PHI in the payload. |
| `AUDIT_RETENTION_DAYS` | Purge audit logs older than N days. | HIPAA expects **≥6 years** — suggest `2555`. Unset = keep forever. |
| `CHAT_LOG_RETENTION_DAYS` | Purge assistant chat logs older than N days. | e.g. `365`. |
| `KPI_FLAG_RETENTION_DAYS` | Purge resolved/dismissed KPI flags older than N days. | e.g. `180`. |
| `FAILED_PAYMENT_WEBHOOK_INCLUDE_PII` | Re-include name/email/phone in the failed-payment hook. | Leave **unset** unless the receiver is BAA-covered; by default only ids + a profile link are sent. |
| `ANTHROPIC_API_KEY` | Enables the assistant's LLM answers (Training mode). | The model backend must be **BAA-covered** (Bedrock/Azure OpenAI or Anthropic under a BAA). Without it, chat still works (search + aggregate answers). |

## 2. Two-factor auth (built)

Super admins enroll under **Admin → Security**: scan the key into any
authenticator app, verify a code, done. MFA is enforced at login **only after
enrollment**, so an unenrolled or half-enrolled admin is never locked out.
Login also throttles after 8 failed attempts in 15 minutes and alerts on-call.

The one way an *enrolled* admin can be locked out is losing the encryption key
their secret was stored under — see [Rotating the key](#rotating-the-key) for
the symptom and the `--clear-mfa` recovery.

## 3. Encryption at rest (built)

`FIELD_ENCRYPTION_KEY` turns on AES-256-GCM field encryption for the sensitive
free-text columns. It's transparent: new writes encrypt, reads decrypt, and old
plaintext rows still read (lazy migration). A configured-but-malformed key
throws rather than silently storing plaintext.

### Rotating the key

Set `FIELD_ENCRYPTION_KEY` to the new key and move the old one into
`FIELD_ENCRYPTION_KEY_PREVIOUS` (comma-separated if there is more than one).
Reads try the primary first, then each previous key; writes always use the
primary, so rows re-encrypt under the new key as they are updated. Drop a key
from `_PREVIOUS` only once nothing is still encrypted under it.

**Rotating without this leaves the old rows permanently unreadable.** A value
encrypted under a discarded key still looks like valid ciphertext but fails its
GCM authentication tag; `decryptField` then returns `DECRYPT_FAILED` rather
than plaintext. Notably that includes `User.mfaSecret` — an admin whose secret
was encrypted under a lost key **cannot log in**, because no authenticator code
can ever validate. Recover with:

```
DATABASE_URL=... npx tsx scripts/reset-admin-password.ts <email> --clear-mfa
```

To find rows affected by a past rotation, look for values that begin with
`enc:v1:` and fail to decrypt under every configured key.

Still on the roadmap: encrypting **indexed identifiers** (email/phone) needs a
searchable-encryption scheme (deterministic/blind-index), which is a separate
migration — those columns stay queryable plaintext for now.

## 4. Row-Level Security (scaffolded, not enabled)

Postgres RLS is provided as defense-in-depth behind the app-code tenant
scoping, but is **intentionally not enabled** — turning it on without proving
it first would make every query return zero rows.

- Policies: [`prisma/rls/enable-rls.sql`](../prisma/rls/enable-rls.sql)
- Per-request clinic context: [`src/lib/prisma-rls.ts`](../src/lib/prisma-rls.ts)

Enable order (staging first): wire `prisma-rls.ts` into the client → apply the
SQL → exercise every role end-to-end → then production.

## 5. Data retention (built)

The nightly `GET /api/cron/retention` (in the GitHub Actions cron) purges per
the `*_RETENTION_DAYS` vars above. It deletes nothing until they're set.

## 6. Backup & disaster recovery (your action)

Code can't enable backups — do this in the Supabase dashboard:

1. **Enable Point-in-Time Recovery** (PITR) on the production project
   (Database → Backups). Note the retention window (e.g. 7 days).
2. Define **RPO/RTO**: with PITR, RPO ≈ minutes; set an RTO target (e.g. 4h).
3. **Test a restore** quarterly: restore to a scratch project, run the app
   against it, confirm data integrity. Record the run.
4. Railway logs are ephemeral and now PHI-scrubbed — they are not a backup.

## 7. Business Associate Agreements (your action)

Every third party that can see PHI needs a signed BAA before go-live:

| Party | What it sees | Action |
| --- | --- | --- |
| Supabase | Entire database | Sign BAA (Supabase offers one on paid plans). |
| Railway | App runtime + env secrets | Confirm BAA availability; else move hosting. |
| LunarPay / Fortis | Patient name/email/phone + card | BAA with the merchant/processor. |
| InBody / LookinBody | Patient phone + body metrics | BAA with the vendor. |
| Failed-payment webhook receiver (Zapier) | Nothing by default now (ids + link only) | Keep PII off it, or sign a BAA and set `FAILED_PAYMENT_WEBHOOK_INCLUDE_PII=true`. |
| LLM backend (if chat AI enabled) | The user's typed question | Use a BAA-covered model backend only. |

## 8. Audit (built)

Writes and now **reads** are logged: patient-profile views (`customer.view`),
cross-clinic search (`customer.search`), login/logout (`auth.login`/`auth.logout`),
plus all mutations. Clinic admins see their own clinic's log at
`/clinic/audit`; super admins see everything at `/admin/audit`.
