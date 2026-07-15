# API & Route Reference

Every route in the app, grouped by area. Guards are defined in
[`auth-and-tenancy.md`](./auth-and-tenancy.md).

Guard legend:
- **Super admin** = inline `getSession()` + `originalRole === "SUPER_ADMIN"` check.
- **`requireSuperAdminApi`** / **`requireSuperAdminClinicApi`** / **`requireClinicApi`** = the `api-guard.ts` helpers.
- **Token (public)** = no session; access is gated by an unguessable `[token]` in the URL.
- **Secret** = shared-secret / signature check (cron / webhooks).

---

## 1. Page routes (`src/app/**/page.tsx`)

### Auth
| Path | Purpose |
| --- | --- |
| `/` | Root — routes user to the right home based on session. |
| `/login` | Credentials sign-in form. |

### Super admin — layout guard `requireSuperAdmin` (`/admin/*`)
| Path | Purpose |
| --- | --- |
| `/admin` | Global overview / dashboard. |
| `/admin/customers` | Cross-clinic patient search. |
| `/admin/reports` | Revenue-share reporting center (filters, per-patient, clinic balances). |
| `/admin/clinics` | List clinics (with impersonate / delete). |
| `/admin/clinics/new` | Create a clinic + initial clinic admin. |
| `/admin/clinics/[id]/edit` | Edit clinic details + revenue-share config. |
| `/admin/implementors` | Manage sales implementors + commissions. |
| `/admin/inbody` | InBody test inbox: webhook URL, connection test, sync, map/refetch. |
| `/admin/payment-links` | Global (super-admin-owned) reusable payment/master links. |
| `/admin/audit` | Audit log viewer. |

### Clinic workspace — layout guard `requireClinicContext` (`/clinic/*`)
| Path | Purpose |
| --- | --- |
| `/clinic` | Clinic overview. |
| `/clinic/customers` | Customer list. |
| `/clinic/customers/new` | Create a customer. |
| `/clinic/customers/[id]` | Customer detail: payment methods, charges, subs, schedules, holds, InBody, care credits, merge, edit. |
| `/clinic/charges` | All transactions for the clinic. |
| `/clinic/subscriptions` | All subscriptions. |
| `/clinic/installments` | All payment schedules (installment plans). |
| `/clinic/invoices` | Payment links (invoices) list + create. |
| `/clinic/invoices/[id]` | Payment link detail. |
| `/clinic/team` | Clinic team (clinic-admin users) management. |
| `/clinic/settings` | Clinic settings (logo, contact info). |

### Public — token-gated (`/pay/*`)
| Path | Purpose |
| --- | --- |
| `/pay/[token]` | Customer-facing hosted payment link (pay / subscribe / master). |
| `/pay/save-card/[token]` | Customer-facing add-a-card page (Fortis Elements). |
| `/pay/success` | Return after successful hosted checkout. |
| `/pay/cancel` | Return after cancelled hosted checkout. |

---

## 2. API routes (`src/app/api/**/route.ts`)

### `admin/*` — super admin
| Method | Path | Guard | Purpose |
| --- | --- | --- | --- |
| POST | `/api/admin/clinics` | Super admin | Create clinic + initial clinic admin. |
| PATCH / DELETE | `/api/admin/clinics/[id]` | Super admin | Update / delete a clinic. |
| POST / DELETE | `/api/admin/clinics/[id]/logo` | Super admin | Upload / remove clinic logo. |
| GET | `/api/admin/customers/search` | `requireSuperAdminApi` | Cross-clinic customer search. |
| POST | `/api/admin/impersonate/start` | Super admin | Begin impersonating a clinic (audit). |
| POST | `/api/admin/impersonate/stop` | Super admin | Stop impersonating (audit). |
| GET / POST | `/api/admin/implementors` | Super admin | List / create implementors. |
| PATCH / DELETE | `/api/admin/implementors/[id]` | Super admin | Update / delete implementor. |
| GET / POST | `/api/admin/reports` | Super admin | List / save report definitions. |
| DELETE | `/api/admin/reports/[id]` | Super admin | Delete a saved report. |
| GET / POST | `/api/admin/payment-links` | Super admin | List / create global payment links. |
| DELETE | `/api/admin/payment-links/[id]` | Super admin | Disable a global payment link. |
| POST | `/api/admin/advanced-costs` | Super admin | Log an advanced cost. |
| DELETE | `/api/admin/advanced-costs/[id]` | Super admin | Delete an advanced cost. |
| POST | `/api/admin/clinic-payouts` | Super admin | Record a payout to a clinic. |
| DELETE | `/api/admin/clinic-payouts/[id]` | Super admin | Delete a payout. |
| POST | `/api/admin/inbody/connection-test` | `requireSuperAdminApi` | Test InBody API credentials. |
| POST | `/api/admin/inbody/sync-today` | `requireSuperAdminApi` | Pull today's InBody measurements. |
| POST | `/api/admin/inbody/backfill` | `requireSuperAdminApi` | Re-fetch up to 500 historical tests that still lack metrics. |
| POST | `/api/admin/inbody/tests/[id]/map` | `requireSuperAdminApi` | Map/unmap a test to a customer. |
| POST | `/api/admin/inbody/tests/[id]/refetch` | `requireSuperAdminApi` | Re-fetch a test's results. |
| POST / GET | `/api/admin/lunarpay/reconcile-subscriptions` | `requireSuperAdminApi` | Manually run subscription reconciliation. |
| POST / GET | `/api/admin/lunarpay/probe-transactions` | `requireSuperAdminApi` | Diagnostic probe of LunarPay transactions. |
| POST | `/api/admin/wipe-test-data` | Super admin | Destructive: wipe test data. |

### `clinic/*` — clinic workspace
| Method | Path | Guard | Purpose |
| --- | --- | --- | --- |
| POST | `/api/clinic/customers` | `requireClinicApi` | Create a customer. |
| PATCH / DELETE | `/api/clinic/customers/[id]` | `requireSuperAdminClinicApi` | Edit / delete a customer. |
| POST | `/api/clinic/customers/[id]/merge` | `requireSuperAdminClinicApi` | Merge two customer records. |
| POST | `/api/clinic/customers/[id]/intention` | `requireClinicApi` | Mint a Fortis tokenization intention (in-admin add card). |
| POST | `/api/clinic/customers/[id]/payment-methods` | `requireClinicApi` | Save a tokenized payment method. |
| PATCH | `/api/clinic/customers/[id]/payment-methods/[pmId]` | `requireClinicApi` | Set default / update a method. |
| DELETE | `/api/clinic/customers/[id]/payment-methods/[pmId]` | `requireSuperAdminClinicApi` | Remove a payment method. |
| POST | `/api/clinic/customers/[id]/payment-methods/[pmId]/reassign` | `requireSuperAdminClinicApi` | Reassign a card to another customer profile. |
| POST | `/api/clinic/customers/[id]/charges` | `requireClinicApi` | One-time charge. |
| POST | `/api/clinic/customers/[id]/subscriptions` | `requireClinicApi` | Create a subscription. |
| POST | `/api/clinic/customers/[id]/holds` | `requireClinicApi` | Create an auth hold. |
| POST | `/api/clinic/customers/[id]/holds/[holdId]/capture` | `requireClinicApi` | Capture a hold. |
| POST | `/api/clinic/customers/[id]/holds/[holdId]/void` | `requireClinicApi` | Void a hold. |
| POST | `/api/clinic/customers/[id]/invoices` | `requireClinicApi` | Generate a payment link for the customer. |
| POST / DELETE | `/api/clinic/customers/[id]/save-card-link` | `requireClinicApi` | Create / disable a save-card link. |
| POST | `/api/clinic/customers/[id]/care-credits` | `requireSuperAdminClinicApi` | Log a care-credit payment. |
| DELETE | `/api/clinic/customers/[id]/care-credits/[ccId]` | `requireSuperAdminClinicApi` | Delete a care-credit entry. |
| POST | `/api/clinic/charges/[id]/refund` | `requireSuperAdminClinicApi` | Refund a charge (full/partial). |
| POST | `/api/clinic/subscriptions/[id]/cancel` | `requireSuperAdminClinicApi` | Cancel a subscription. |
| POST | `/api/clinic/subscriptions/[id]/reschedule` | `requireSuperAdminClinicApi` | Change next payment date. |
| POST | `/api/clinic/subscriptions/[id]/swap-card` | `requireSuperAdminClinicApi` | Change the funding card. |
| GET | `/api/clinic/schedules/[id]` | `requireSuperAdminClinicApi` | Get a payment schedule. |
| POST | `/api/clinic/schedules/[id]/cancel` | `requireSuperAdminClinicApi` | Cancel a schedule. |
| POST | `/api/clinic/schedules/[id]/reschedule` | `requireSuperAdminClinicApi` | Reschedule a schedule. |
| POST | `/api/clinic/payment-links` | `requireClinicApi` | Create a reusable payment link. |
| DELETE | `/api/clinic/payment-links/[id]` | `requireClinicApi` | Disable a payment link. |
| GET / POST | `/api/clinic/team` | `requireClinicApi` | List / add clinic team members. |
| PATCH / DELETE | `/api/clinic/team/[id]` | `requireClinicApi` | Update / remove a team member. |
| PATCH | `/api/clinic/settings` | Clinic-scoped (`getSession`) | Update clinic settings. |
| POST / DELETE | `/api/clinic/settings/logo` | Clinic-scoped (`getSession`) | Upload / remove clinic logo. |

### `public/*` — token-gated (no session)
| Method | Path | Guard | Purpose |
| --- | --- | --- | --- |
| POST | `/api/public/payment-link/[token]` | Token | Submit a hosted payment-link payment (payment/subscription/combined/master). |
| POST | `/api/public/payment-link/[token]/intention` | Token | Mint a Fortis tokenization intention for the link. |
| POST | `/api/public/save-card/[token]` | Token | Save a card via a save-card link. |
| POST | `/api/public/save-card/[token]/intention` | Token | Mint a tokenization intention for save-card. |

### `webhooks/*` — external senders (`Secret`)
| Method | Path | Guard | Purpose |
| --- | --- | --- | --- |
| POST | `/api/webhooks/lunarpay` | HMAC (`LUNARPAY_WEBHOOK_SECRET`) | Handle payment/charge/subscription/checkout events. |
| POST | `/api/webhooks/inbody` | Secret header + `Account` match | Ingest a LookinBody scan notification. |

> `/webhooks/lunarpay` and `/webhooks/inbody` (no `/api` prefix) are **aliases**
> that re-export `POST` from the `/api/webhooks/*` handlers — same behavior. They
> exist because LunarPay / LookinBody registration examples use the shorter path.

### `cron/*`
| Method | Path | Guard | Purpose |
| --- | --- | --- | --- |
| GET | `/api/cron/reconcile-subscriptions` | `Bearer CRON_SECRET` (503 if unset) | Nightly backfill of recurring charges. Scheduled by `vercel.json`. |

### `auth/*`, `health/*`, `debug/*`
| Method | Path | Guard | Purpose |
| --- | --- | --- | --- |
| GET/POST | `/api/auth/[...nextauth]` | NextAuth | Sign-in / session endpoints. |
| GET | `/api/health` | None | Liveness check. |
| POST | `/api/health/login-check` | **None ⚠️** | Debug credential check. **REMOVE BEFORE PRODUCTION.** |
| GET/POST | `/api/debug/lunarpay-intentions` | **None ⚠️** | Read-only LunarPay intention diagnostic. Debug-only. |

⚠️ The two flagged endpoints are unauthenticated by design for debugging and
must be removed before going live (see [`operations.md`](./operations.md)).
