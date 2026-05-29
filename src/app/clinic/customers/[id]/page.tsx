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
import { CancelScheduleButton } from "./cancel-schedule";
import { DeleteCustomerButton } from "./delete-customer-button";
import { HoldsSection } from "./holds-section";

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
    },
  });
  if (!customer) notFound();

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
          <DeleteCustomerButton customerId={customer.id} customerName={fullName} />
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <PaymentMethods
            customerId={customer.id}
            existingUpdateCardUrl={existingUpdateCardLink?.url ?? null}
            canRemoveCard={canPerformSensitiveActions}
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
                  <th>Status</th>
                  <th>Next</th>
                  <th className="text-right pr-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {customer.subscriptions.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-center text-slate-500 py-6">
                      No subscriptions.
                    </td>
                  </tr>
                )}
                {customer.subscriptions.map((s) => (
                  <tr key={s.id}>
                    <td>{formatMoneyCents(s.amountCents)}</td>
                    <td className="capitalize">{s.frequency}</td>
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
                        <CancelSubscriptionButton subscriptionId={s.id} />
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
                        <CancelScheduleButton scheduleId={s.id} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="space-y-6">
          <NewChargeForm
            customerId={customer.id}
            methods={customer.paymentMethods.map((m) => ({
              id: m.id,
              label: formatMethodLabel(m),
            }))}
          />
          <NewSubscriptionForm customerId={customer.id} />
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
