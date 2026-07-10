import Link from "next/link";
import { requireClinicContext, isSuperAdmin, getSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { formatMoneyCents, formatDate } from "@/lib/format";
import { CancelScheduleButton } from "../customers/[id]/cancel-schedule";
import {
  toCsv,
  csvMoney,
  parsePaymentsJson,
  nextScheduledDate,
  formatDateOnly,
} from "@/lib/csv";
import { DownloadCsvButton } from "@/components/download-csv-button";

export const dynamic = "force-dynamic";

export default async function InstallmentsPage() {
  const { clinicId } = await requireClinicContext();
  const session = await getSession();
  const canCancel = isSuperAdmin(session);

  const schedules = await prisma.paymentSchedule.findMany({
    where: { clinicId },
    orderBy: { createdAt: "desc" },
    include: { customer: true },
  });

  const csv = toCsv(
    [
      "Customer",
      "Email",
      "Total",
      "Paid",
      "Status",
      "Description",
      "Scheduled dates",
      "Next scheduled",
      "Started",
    ],
    schedules.map((s) => {
      const payments = parsePaymentsJson(s.paymentsJson);
      return [
        [s.customer.firstName, s.customer.lastName].filter(Boolean).join(" ") ||
          s.customer.email ||
          "Customer",
        s.customer.email,
        csvMoney(s.totalAmountCents),
        csvMoney(s.paidAmountCents),
        s.status,
        s.description,
        payments.map((p) => `${p.date} (${csvMoney(p.amount)}${p.status ? ` ${p.status}` : ""})`).join("; "),
        nextScheduledDate(payments) ?? "",
        s.createdAt.toISOString(),
      ];
    }),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">
            Installment plans
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Scheduled multi-payment plans. Cancelling stops future
            installments; refund already-collected payments individually from
            the customer&apos;s Transactions list.
          </p>
        </div>
        <DownloadCsvButton csv={csv} filename="installments.csv" />
      </div>

      <div className="card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Total</th>
              <th>Paid</th>
              <th>Status</th>
              <th>Scheduled dates</th>
              <th>Description</th>
              <th>Started</th>
              <th className="text-right pr-4">Actions</th>
            </tr>
          </thead>
          <tbody>
            {schedules.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center text-slate-500 py-10">
                  No installment plans yet.
                </td>
              </tr>
            )}
            {schedules.map((s) => {
              const fullName =
                [s.customer.firstName, s.customer.lastName]
                  .filter(Boolean)
                  .join(" ") ||
                s.customer.email ||
                "Customer";
              const payments = parsePaymentsJson(s.paymentsJson);
              return (
                <tr key={s.id}>
                  <td>
                    <Link
                      href={`/clinic/customers/${s.customerId}`}
                      className="text-brand-600 hover:underline font-medium"
                    >
                      {fullName}
                    </Link>
                    {s.customer.email && (
                      <div className="text-xs text-slate-400">
                        {s.customer.email}
                      </div>
                    )}
                  </td>
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
                  <td className="text-slate-600 text-xs">
                    {payments.length === 0 ? (
                      <span className="text-slate-400">—</span>
                    ) : (
                      <div className="space-y-0.5">
                        {payments.map((p, i) => (
                          <div key={i}>
                            <span className="font-medium text-slate-800">
                              {formatDateOnly(p.date)}
                            </span>
                            <span className="text-slate-400">
                              {" "}
                              · {formatMoneyCents(p.amount)}
                              {p.status ? ` · ${p.status}` : ""}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className="text-slate-600">{s.description || "—"}</td>
                  <td className="text-slate-500 text-xs">
                    {formatDate(s.createdAt)}
                  </td>
                  <td className="text-right pr-4">
                    {s.status === "active" && canCancel && (
                      <CancelScheduleButton scheduleId={s.id} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
