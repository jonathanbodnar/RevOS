import Link from "next/link";
import { requireClinicAdminContext, isSuperAdmin, getSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { formatMoneyCents, formatDate, formatCardLabel } from "@/lib/format";
import { RefundButton } from "../customers/[id]/refund-button";
import { toCsv, csvMoney } from "@/lib/csv";
import { DownloadCsvButton } from "@/components/download-csv-button";

const STATUS_FILTERS = ["paid", "pending", "failed", "refunded"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

export default async function ChargesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { clinicId } = await requireClinicAdminContext();
  const session = await getSession();
  const canRefund = isSuperAdmin(session);
  const { status } = await searchParams;
  const statusFilter = STATUS_FILTERS.includes(status as StatusFilter)
    ? (status as StatusFilter)
    : null;

  const charges = await prisma.charge.findMany({
    where: { clinicId, ...(statusFilter ? { status: statusFilter } : {}) },
    orderBy: { createdAt: "desc" },
    take: 500,
    include: {
      customer: true,
      paymentMethod: { select: { sourceType: true, lastDigits: true } },
    },
  });

  const csv = toCsv(
    [
      "Customer",
      "Email",
      "Amount",
      "Refunded",
      "Card",
      "Status",
      "Description",
      "When",
      "LunarPay charge id",
    ],
    charges.map((c) => [
      [c.customer.firstName, c.customer.lastName].filter(Boolean).join(" ") ||
        c.customer.email ||
        "Customer",
      c.customer.email,
      csvMoney(c.amountCents),
      csvMoney(c.refundedCents),
      formatCardLabel(c.paymentMethod) ?? "",
      c.status,
      c.description,
      c.createdAt.toISOString(),
      c.lunarpayChargeId,
    ]),
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm">
          <Link
            href="/clinic/charges"
            className={statusFilter ? "btn-ghost px-3 py-1" : "btn-primary px-3 py-1"}
          >
            All
          </Link>
          {STATUS_FILTERS.map((s) => (
            <Link
              key={s}
              href={`/clinic/charges?status=${s}`}
              className={statusFilter === s ? "btn-primary px-3 py-1" : "btn-ghost px-3 py-1"}
            >
              {s[0].toUpperCase() + s.slice(1)}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-3">
          <p className="text-sm text-slate-500">
            {charges.length} transaction{charges.length === 1 ? "" : "s"}
            {charges.length >= 500 ? " (latest 500)" : ""}
          </p>
          <DownloadCsvButton
            csv={csv}
            filename={statusFilter ? `transactions-${statusFilter}.csv` : "transactions.csv"}
          />
        </div>
      </div>
      <div className="card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Amount</th>
              <th>Refunded</th>
              <th>Card</th>
              <th>Status</th>
              <th>Description</th>
              <th>When</th>
              {canRefund && <th className="text-right pr-3">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {charges.length === 0 && (
              <tr>
                <td
                  colSpan={canRefund ? 8 : 7}
                  className="text-center text-slate-500 py-10"
                >
                  {statusFilter ? `No ${statusFilter} transactions.` : "No transactions yet."}
                </td>
              </tr>
            )}
            {charges.map((c) => {
              const remaining = c.amountCents - c.refundedCents;
              const refundable =
                ["paid", "refunded"].includes(c.status) && remaining > 0;
              return (
                <tr key={c.id}>
                  <td>
                    <Link
                      href={`/clinic/customers/${c.customerId}`}
                      className="text-brand-600 hover:underline"
                    >
                      {[c.customer.firstName, c.customer.lastName]
                        .filter(Boolean)
                        .join(" ") ||
                        c.customer.email ||
                        "Customer"}
                    </Link>
                  </td>
                  <td>{formatMoneyCents(c.amountCents)}</td>
                  <td>
                    {c.refundedCents ? formatMoneyCents(c.refundedCents) : "—"}
                  </td>
                  <td className="text-slate-600 text-xs whitespace-nowrap">
                    {formatCardLabel(c.paymentMethod) ?? (
                      <span className="text-slate-400">—</span>
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
                  {canRefund && (
                    <td className="text-right pr-3">
                      {refundable && (
                        <RefundButton
                          chargeId={c.id}
                          maxCents={remaining}
                          originalCents={c.amountCents}
                        />
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
