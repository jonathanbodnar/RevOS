import Link from "next/link";
import { notFound } from "next/navigation";
import { requireClinicContext, isSuperAdmin, getSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { formatMoneyCents, formatDate } from "@/lib/format";
import { PaymentMethods } from "./payment-methods";
import { NewChargeForm } from "./new-charge";
import { NewSubscriptionForm } from "./new-subscription";
import { RefundButton } from "./refund-button";
import { CancelSubscriptionButton } from "./cancel-subscription";
import { SwapCardButton } from "./swap-card-button";
import { RescheduleSubscriptionButton } from "./reschedule-subscription";
import { CancelScheduleButton } from "./cancel-schedule";
import { RescheduleInstallmentButton } from "./reschedule-installment";
import { DeleteCustomerButton } from "./delete-customer-button";
import { HoldsSection } from "./holds-section";
import { CustomerAttribution } from "./customer-attribution";
import { CareCredits } from "./care-credits";
import { EditCustomerButton } from "./edit-customer";
import { MergeCustomerButton } from "./merge-customer";

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { clinicId } = await requireClinicContext();
  const session = await getSession();
  const canPerformSensitiveActions = isSuperAdmin(session);

  const customer = await prisma.customer.findFirst({
    where: { id, clinicId },
    include: {
      paymentMethods: {
        where: { isActive: true },
        orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
      },
      charges: { orderBy: { createdAt: "desc" }, take: 50 },
      subscriptions: { orderBy: { createdAt: "desc" } },
      schedules: { orderBy: { createdAt: "desc" } },
      careCredits: { orderBy: { collectedOn: "desc" } },
    },
  });
  if (!customer) notFound();

  // Other patients in this clinic — used as reassign targets for saved cards
  // (super-admin only). Kept lightweight (id + label).
  const otherCustomers = canPerformSensitiveActions
    ? (
        await prisma.customer.findMany({
          where: { clinicId, id: { not: customer.id } },
          orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
          select: { id: true, firstName: true, lastName: true, email: true },
          take: 1000,
        })
      ).map((c) => ({
        id: c.id,
        label:
          [c.firstName, c.lastName].filter(Boolean).join(" ").trim() ||
          c.email ||
          c.id,
      }))
    : [];

  // Implementor options (super-admin attribution UI only).
  const implementors = canPerformSensitiveActions
    ? await prisma.implementor.findMany({
        where: { isActive: true },
        orderBy: { name: "asc" },
        select: { id: true, name: true },
      })
    : [];

  // Customer-specific update-card link, if one already exists. The
  // PaymentMethods component lazy-mints one on demand if not.
  const existingUpdateCardLink = await prisma.checkoutSession.findFirst({
    where: {
      clinicId,
      customerId: customer.id,
      mode: "save_card",
      status: "open",
    },
    orderBy: { createdAt: "desc" },
    select: { url: true },
  });

  const fullName =
    [customer.firstName, customer.lastName].filter(Boolean).join(" ") ||
    customer.email ||
    "Customer";

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <Link
            href="/clinic/customers"
            className="text-xs text-slate-500 hover:underline"
          >
            ← All customers
          </Link>
          <h2 className="text-xl font-semibold text-slate-900 mt-1">
            {fullName}
          </h2>
          <p className="text-sm text-slate-500">
            {customer.email || "—"} · {customer.phone || "—"}
          </p>
          {customer.lunarpayCustomerId ? (
            <p className="text-xs text-slate-400 mt-1">
              LunarPay id: {customer.lunarpayCustomerId}
            </p>
          ) : (
            <p className="text-xs text-amber-600 mt-1">
              Not yet synced to LunarPay.
            </p>
          )}
        </div>
        {canPerformSensitiveActions && (
          <div className="flex items-center gap-2">
            <EditCustomerButton
              customerId={customer.id}
              initial={{
                firstName: customer.firstName,
                lastName: customer.lastName,
                email: customer.email,
                phone: customer.phone,
              }}
            />
            <MergeCustomerButton
              customerId={customer.id}
              otherCustomers={otherCustomers}
            />
            <DeleteCustomerButton customerId={customer.id} customerName={fullName} />
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <PaymentMethods
            customerId={customer.id}
            existingUpdateCardUrl={existingUpdateCardLink?.url ?? null}
            canRemoveCard={canPerformSensitiveActions}
            canReassign={canPerformSensitiveActions}
            otherCustomers={otherCustomers}
            methods={customer.paymentMethods.map((m) => ({
              id: m.id,
              lunarpayPaymentMethodId: m.lunarpayPaymentMethodId,
              sourceType: m.sourceType,
              lastDigits: m.lastDigits,
              nameHolder: m.nameHolder,
              isDefault: m.isDefault,
              expMonth: m.expMonth,
              expYear: m.expYear,
            }))}
          />

          {/* Holds — authorized-only charges */}
          <HoldsSection
            customerId={customer.id}
            holds={customer.charges
              .filter((c) => ["authorized", "voided"].includes(c.status))
              .map((c) => ({
                id: c.id,
                amountCents: c.amountCents,
                status: c.status,
                description: c.description,
                createdAt: c.createdAt,
              }))}
            methods={customer.paymentMethods.map((m) => ({
              id: m.id,
              label: formatMethodLabel(m),
              sourceType: m.sourceType,
            }))}
          />

          <div className="card-pad">
            <h3 className="text-sm font-semibold text-slate-900 mb-3">
              Transactions
            </h3>
            <table className="table">
              <thead>
                <tr>
                  <th>Amount</th>
                  <th>Status</th>
                  <th>Description</th>
                  <th>When</th>
                  <th className="text-right pr-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {customer.charges.filter((c) => !["authorized", "voided"].includes(c.status)).length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-center text-slate-500 py-6">
                      No transactions yet.
                    </td>
                  </tr>
                )}
                {customer.charges
                  .filter((c) => !["authorized", "voided"].includes(c.status))
                  .map((c) => (
                  <tr key={c.id}>
                    <td>
                      <div className="font-medium">
                        {formatMoneyCents(c.amountCents)}
                      </div>
                      {c.refundedCents > 0 && (
                        <div className="text-xs text-slate-500">
                          refunded {formatMoneyCents(c.refundedCents)}
                        </div>
                      )}
                    </td>
                    <td>
                      <span
                        className={
                          c.status === "paid"
                            ? "badge-green"
                            : c.status === "refunded"
                              ? "badge-slate"
                              : c.status === "failed"
                                ? "badge-red"
                                : "badge-yellow"
                        }
                      >
                        {c.status}
                      </span>
                    </td>
                    <td className="text-slate-600">{c.description || "—"}</td>
                    <td className="text-slate-500 text-xs">
                      {formatDate(c.createdAt)}
                    </td>
                    <td className="text-right pr-3">
                      {canPerformSensitiveActions &&
                        c.status !== "refunded" &&
                        c.refundedCents < c.amountCents && (
                          <RefundButton
                            chargeId={c.id}
                            maxCents={c.amountCents - c.refundedCents}
                            originalCents={c.amountCents}
                          />
                        )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card-pad">
            <h3 className="text-sm font-semibold text-slate-900 mb-3">
              Subscriptions
            </h3>
            <table className="table">
              <thead>
                <tr>
                  <th>Amount</th>
                  <th>Frequency</th>
                  <th>Card</th>
                  <th>Status</th>
                  <th>Next</th>
                  <th className="text-right pr-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {customer.subscriptions.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center text-slate-500 py-6">
                      No subscriptions.
                    </td>
                  </tr>
                )}
                {customer.subscriptions.map((s) => (
                  <tr key={s.id}>
                    <td>{formatMoneyCents(s.amountCents)}</td>
                    <td className="capitalize">{s.frequency}</td>
                    <td className="text-slate-600 text-xs">
                      {methodCardLabel(s.paymentMethodId, customer.paymentMethods)}
                    </td>
                    <td>
                      <span
                        className={
                          s.status === "active" ? "badge-green" : "badge-slate"
                        }
                      >
                        {s.status}
                      </span>
                    </td>
                    <td className="text-slate-500 text-xs">
                      {formatDate(s.nextPaymentOn)}
                    </td>
                    <td className="text-right pr-3">
                      {s.status === "active" && canPerformSensitiveActions && (
                        <div className="flex items-center justify-end gap-1">
                          <RescheduleSubscriptionButton
                            subscriptionId={s.id}
                            currentNextPaymentOn={
                              s.nextPaymentOn
                                ? s.nextPaymentOn.toISOString()
                                : null
                            }
                          />
                          <SwapCardButton
                            subscriptionId={s.id}
                            currentPaymentMethodId={s.paymentMethodId}
                            methods={customer.paymentMethods.map((m) => ({
                              id: m.id,
                              label: formatMethodLabel(m),
                            }))}
                          />
                          <CancelSubscriptionButton subscriptionId={s.id} />
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card-pad">
            <div className="flex items-baseline justify-between mb-1">
              <h3 className="text-sm font-semibold text-slate-900">
                Installment plans
              </h3>
              {customer.schedules.length > 0 && (
                <p className="text-xs text-slate-400">
                  Refund individual paid installments from the Transactions
                  list above.
                </p>
              )}
            </div>
            <table className="table">
              <thead>
                <tr>
                  <th>Total</th>
                  <th>Paid</th>
                  <th>Status</th>
                  <th>Description</th>
                  <th>Started</th>
                  <th className="text-right pr-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {customer.schedules.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center text-slate-500 py-6">
                      No installment plans.
                    </td>
                  </tr>
                )}
                {customer.schedules.map((s) => (
                  <tr key={s.id}>
                    <td className="font-medium">
                      {formatMoneyCents(s.totalAmountCents)}
                    </td>
                    <td className="text-slate-600">
                      {formatMoneyCents(s.paidAmountCents)}
                      <span className="text-slate-400">
                        {" "}
                        / {formatMoneyCents(s.totalAmountCents)}
                      </span>
                    </td>
                    <td>
                      <span
                        className={
                          s.status === "active"
                            ? "badge-green"
                            : s.status === "completed"
                              ? "badge-indigo"
                              : "badge-slate"
                        }
                      >
                        {s.status}
                      </span>
                    </td>
                    <td className="text-slate-600">{s.description || "—"}</td>
                    <td className="text-slate-500 text-xs">
                      {formatDate(s.createdAt)}
                    </td>
                    <td className="text-right pr-3">
                      {s.status === "active" && canPerformSensitiveActions && (
                        <div className="flex items-center justify-end gap-1">
                          <RescheduleInstallmentButton scheduleId={s.id} />
                          <CancelScheduleButton scheduleId={s.id} />
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-6">
          {canPerformSensitiveActions && (
            <CustomerAttribution
              customerId={customer.id}
              implementors={implementors}
              currentImplementorId={customer.implementorId}
              currentNotes={customer.paymentNotes}
            />
          )}
          {canPerformSensitiveActions && (
            <CareCredits
              customerId={customer.id}
              entries={customer.careCredits.map((cc) => ({
                id: cc.id,
                amountCents: cc.amountCents,
                collectedOn: cc.collectedOn.toISOString(),
                note: cc.note,
                source: cc.source,
              }))}
            />
          )}
          <NewChargeForm
            customerId={customer.id}
            methods={customer.paymentMethods.map((m) => ({
              id: m.id,
              label: formatMethodLabel(m),
            }))}
          />
          <NewSubscriptionForm
            customerId={customer.id}
            methods={customer.paymentMethods.map((m) => ({
              id: m.id,
              label: formatMethodLabel(m),
            }))}
          />
        </div>
      </div>
    </div>
  );
}

function formatMethodLabel(m: {
  sourceType: string;
  lastDigits: string | null;
  nameHolder: string | null;
}) {
  const type = m.sourceType === "ach" ? "Bank" : "Card";
  return `${type} •••• ${m.lastDigits ?? "????"} ${m.nameHolder ? `(${m.nameHolder})` : ""}`.trim();
}

function methodCardLabel(
  paymentMethodId: string | null,
  methods: { id: string; sourceType: string; lastDigits: string | null }[],
) {
  if (!paymentMethodId) return "—";
  const m = methods.find((x) => x.id === paymentMethodId);
  if (!m) return "—";
  const type = m.sourceType === "ach" ? "Bank" : "Card";
  return `${type} •••• ${m.lastDigits ?? "????"}`;
}
