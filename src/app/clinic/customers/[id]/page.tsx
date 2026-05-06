import Link from "next/link";
import { notFound } from "next/navigation";
import { requireClinicContext } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { formatMoneyCents, formatDate } from "@/lib/format";
import { PaymentMethods } from "./payment-methods";
import { NewChargeForm } from "./new-charge";
import { NewSubscriptionForm } from "./new-subscription";
import { NewInvoiceForm } from "./new-invoice";
import { RefundButton } from "./refund-button";
import { CancelSubscriptionButton } from "./cancel-subscription";

export default async function CustomerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { clinicId } = await requireClinicContext();

  const customer = await prisma.customer.findFirst({
    where: { id, clinicId },
    include: {
      paymentMethods: {
        where: { isActive: true },
        orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
      },
      charges: { orderBy: { createdAt: "desc" }, take: 25 },
      subscriptions: { orderBy: { createdAt: "desc" } },
      schedules: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!customer) notFound();

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
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <PaymentMethods
            customerId={customer.id}
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

          <div className="card-pad">
            <h3 className="text-sm font-semibold text-slate-900 mb-3">
              Charges
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
                {customer.charges.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-center text-slate-500 py-6">
                      No charges yet.
                    </td>
                  </tr>
                )}
                {customer.charges.map((c) => (
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
                      {c.status !== "refunded" &&
                        c.refundedCents < c.amountCents && (
                          <RefundButton
                            chargeId={c.id}
                            maxCents={c.amountCents - c.refundedCents}
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
                      {s.status === "active" && (
                        <CancelSubscriptionButton subscriptionId={s.id} />
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
          <NewInvoiceForm customerId={customer.id} email={customer.email ?? ""} />
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
