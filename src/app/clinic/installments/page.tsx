import Link from "next/link";
import { requireClinicContext, isSuperAdmin, getSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { formatMoneyCents, formatDate } from "@/lib/format";
import { CancelScheduleButton } from "../customers/[id]/cancel-schedule";

// Force-dynamic so newly-created plans show up immediately without an
// edge cache stalling the list.
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

  return (
    <div className="space-y-4">
      <div className="flex items-baseline justify-between">
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
      </div>

      <div className="card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Total</th>
              <th>Paid</th>
              <th>Status</th>
              <th>Description</th>
              <th>Started</th>
              <th className="text-right pr-4">Actions</th>
            </tr>
          </thead>
          <tbody>
            {schedules.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-slate-500 py-10">
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
