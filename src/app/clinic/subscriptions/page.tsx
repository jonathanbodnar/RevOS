import Link from "next/link";
import { requireClinicAdminContext, isSuperAdmin, getSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { formatMoneyCents, formatDate } from "@/lib/format";
import { CancelSubscriptionButton } from "../customers/[id]/cancel-subscription";
import { toCsv, csvMoney, formatDateOnly } from "@/lib/csv";
import { DownloadCsvButton } from "@/components/download-csv-button";

export const dynamic = "force-dynamic";

export default async function SubscriptionsPage() {
  const { clinicId } = await requireClinicAdminContext();
  const session = await getSession();
  const canCancel = isSuperAdmin(session);

  const subs = await prisma.subscription.findMany({
    where: { clinicId },
    orderBy: { createdAt: "desc" },
    include: { customer: true },
  });

  const csv = toCsv(
    [
      "Customer",
      "Email",
      "Amount",
      "Frequency",
      "Status",
      "Next payment (scheduled)",
      "Started",
    ],
    subs.map((s) => [
      [s.customer.firstName, s.customer.lastName].filter(Boolean).join(" ") ||
        s.customer.email ||
        "Customer",
      s.customer.email,
      csvMoney(s.amountCents),
      s.frequency,
      s.status,
      s.nextPaymentOn ? s.nextPaymentOn.toISOString().slice(0, 10) : "",
      (s.startOn ?? s.createdAt).toISOString(),
    ]),
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">
          {subs.length} subscription{subs.length === 1 ? "" : "s"}
        </p>
        <DownloadCsvButton csv={csv} filename="subscriptions.csv" />
      </div>
      <div className="card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Amount</th>
              <th>Frequency</th>
              <th>Status</th>
              <th>Next payment</th>
              <th>Started</th>
              <th className="text-right pr-4">Actions</th>
            </tr>
          </thead>
          <tbody>
            {subs.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-slate-500 py-10">
                  No subscriptions yet.
                </td>
              </tr>
            )}
            {subs.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link
                    href={`/clinic/customers/${s.customerId}`}
                    className="text-brand-600 hover:underline font-medium"
                  >
                    {[s.customer.firstName, s.customer.lastName]
                      .filter(Boolean)
                      .join(" ") ||
                      s.customer.email ||
                      "Customer"}
                  </Link>
                  {s.customer.email && (
                    <div className="text-xs text-slate-400">
                      {s.customer.email}
                    </div>
                  )}
                </td>
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
                  {s.nextPaymentOn
                    ? formatDateOnly(s.nextPaymentOn.toISOString().slice(0, 10))
                    : "—"}
                </td>
                <td className="text-slate-500 text-xs">
                  {formatDate(s.startOn ?? s.createdAt)}
                </td>
                <td className="text-right pr-4">
                  {s.status === "active" && canCancel && (
                    <CancelSubscriptionButton subscriptionId={s.id} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
