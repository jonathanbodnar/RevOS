# Glossary

Domain vocabulary used throughout RevOS. See linked docs for detail.

| Term | Meaning |
| --- | --- |
| **RevOS** | The platform operator (the super-admin company) that onboards clinics and takes a revenue share. |
| **Super admin** | `Role.SUPER_ADMIN`. Global access; can create clinics, run reports, and impersonate any clinic. |
| **Clinic** | A tenant. Manages its own customers and billing. Has revenue-share config. |
| **Clinic admin** | `Role.CLINIC_ADMIN`. Scoped to one clinic's workspace. |
| **Impersonation** | A super admin scoping into a clinic to operate as if a clinic admin; `effectiveClinicId` is set, `originalRole` stays `SUPER_ADMIN`. Audit-logged. See [auth](./auth-and-tenancy.md). |
| **Customer** | A patient. Belongs to one clinic. No login. Mirrors a LunarPay customer. |
| **Implementor** | A salesperson credited for closing a down payment; earns `commissionCents`. Attributed via `?implementor=<name>` link tag or manually. |
| **LunarPay** | The single shared payment merchant/processor all clinics run through. |
| **Fortis Elements** | The iframe SDK that tokenizes card data client-side so raw PANs never reach RevOS. |
| **tokenizeId** | The `account_vault_id` Fortis returns after tokenizing a card; RevOS exchanges it for a LunarPay `paymentMethodId`. |
| **Charge** | A single debit. Statuses: `paid`, `pending` (ACH), `refunded`, `failed`, `authorized` (hold), `voided`. |
| **Refund** | Full/partial reversal of a settled charge; tracked in `refundedCents`. |
| **Subscription** | Recurring billing; LunarPay's cron drives cycles. |
| **Payment schedule / installments** | A fixed set of dated payments (`PaymentSchedule`). |
| **Hold (auth)** | A charge created with `capture:false` that reserves funds; later captured or voided. |
| **Checkout session / payment link** | A hosted or reusable link a customer pays through (`CheckoutSession`). Reusable links stay `open` and spawn many charges/subs. |
| **Save-card link** | A link that vaults a customer's card with no charge. |
| **Master link** | A reusable global link where the payer chooses amounts: a down payment (optionally split 50/50) + optional fixed $250/mo subscription. |
| **Down payment** | The initial (non-recurring) payment; split by `revosDownPaymentSharePct`. |
| **Recurring charge** | A subscription cycle charge; identified by the description marker `"Subscription renewal"`; RevOS takes `revosRecurringShareCents` per cycle. |
| **Care credit** | Money a patient paid the clinic directly via external financing (e.g. CareCredit). No card charged; RevOS is *owed* its share. |
| **Advanced cost** | A cost RevOS fronted for a clinic (supplements, booklets); reduces RevOS net. |
| **Clinic payout** | Money RevOS has remitted to a clinic; reduces the clinic balance. |
| **Customer-facing fee** | 3.9% + $0.39 added on top of the base price; **RevOS revenue**. |
| **LunarPay fee** | The 3.9% + $0.39 LunarPay charges RevOS on the gross; **RevOS cost**. |
| **Balance due** | Per clinic: clinic's share of collected payments − care-credit RevOS take − payouts. See [reporting](./reporting.md). |
| **Reconciliation** | Nightly self-healing backfill of recurring charges from LunarPay's `successTrxns` counter. |
| **InBody / LookinBody** | Body-composition scanners / cloud; scans ingested via webhook and paired to customers by phone. |
| **Audit log** | Record of sensitive actions (`AuditLog`), written by `logAudit()`. |
