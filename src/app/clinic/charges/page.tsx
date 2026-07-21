import Link from "next/link";
import { requireClinicAdminContext, isSuperAdmin, getSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { formatMoneyCents, formatDate } from "@/lib/format";
import { RefundButton } from "../customers/[id]/refund-button";
import { toCsv, csvMoney } from "@/lib/csv";
import { DownloadCsvButton } from "@/components/download-csv-button";

export default async function ChargesPage() {
  const { clinicId } = await requireClinicAdminContext();
  const session = await getSession();
  const canRefund = isSuperAdmin(session);

  const charges = await prisma.charge.findMany({
    where: { clinicId },
    orderBy: { createdAt: "desc" },
    take: 500,
    include: { customer: true },
  });

  const csv = toCsv(
    [
      "Customer",
      "Email",
      "Amount",
      "Refunded",
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
      c.status,
      c.description,
      c.createdAt.toISOString(),
      c.lunarpayChargeId,
    ]),
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">
          {charges.length} transaction{charges.length === 1 ? "" : "s"}
          {charges.length >= 500 ? " (latest 500)" : ""}
        </p>
        <DownloadCsvButton csv={csv} filename="transactions.csv" />
      </div>
      <div className="card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Amount</th>
              <th>Refunded</th>
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
                  colSpan={canRefund ? 7 : 6}
                  className="text-center text-slate-500 py-10"
                >
                  No transactions yet.
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
