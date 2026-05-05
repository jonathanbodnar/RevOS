import Link from "next/link";
import { requireClinicContext } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { formatMoneyCents, formatDate } from "@/lib/format";

export default async function SubscriptionsPage() {
  const { clinicId } = await requireClinicContext();
  const subs = await prisma.subscription.findMany({
    where: { clinicId },
    orderBy: { createdAt: "desc" },
    include: { customer: true },
  });
  return (
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
          </tr>
        </thead>
        <tbody>
          {subs.length === 0 && (
            <tr>
              <td colSpan={6} className="text-center text-slate-500 py-10">
                No subscriptions yet.
              </td>
            </tr>
          )}
          {subs.map((s) => (
            <tr key={s.id}>
              <td>
                <Link
                  href={`/clinic/customers/${s.customerId}`}
                  className="text-brand-600 hover:underline"
                >
                  {[s.customer.firstName, s.customer.lastName]
                    .filter(Boolean)
                    .join(" ") || s.customer.email || "Customer"}
                </Link>
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
                {formatDate(s.nextPaymentOn)}
              </td>
              <td className="text-slate-500 text-xs">
                {formatDate(s.startOn ?? s.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
