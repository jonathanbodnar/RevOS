import Link from "next/link";
import { requireClinicContext } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { formatMoneyCents, formatDate } from "@/lib/format";

export default async function ClinicOverviewPage() {
  const { clinicId } = await requireClinicContext();

  const [customers, charges, activeSubs, recentCharges] = await Promise.all([
    prisma.customer.count({ where: { clinicId } }),
    prisma.charge.aggregate({
      where: { clinicId },
      _sum: { amountCents: true, refundedCents: true },
      _count: true,
    }),
    prisma.subscription.count({
      where: { clinicId, status: "active" },
    }),
    prisma.charge.findMany({
      where: { clinicId },
      orderBy: { createdAt: "desc" },
      take: 5,
      include: { customer: true },
    }),
  ]);

  const gross = charges._sum.amountCents ?? 0;
  const refunded = charges._sum.refundedCents ?? 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Stat label="Customers" value={customers.toLocaleString()} />
        <Stat label="Transactions" value={(charges._count ?? 0).toLocaleString()} />
        <Stat
          label="Net processed"
          value={formatMoneyCents(gross - refunded)}
        />
        <Stat label="Active subscriptions" value={activeSubs.toLocaleString()} />
      </div>

      <div className="card-pad">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-slate-900">Recent transactions</h2>
          <Link href="/clinic/charges" className="text-xs text-brand-600 hover:underline">
            View all
          </Link>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Customer</th>
              <th>Amount</th>
              <th>Status</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {recentCharges.length === 0 && (
              <tr>
                <td colSpan={4} className="text-center text-slate-500 py-8">
                  No transactions yet.
                </td>
              </tr>
            )}
            {recentCharges.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link
                    href={`/clinic/customers/${c.customerId}`}
                    className="text-brand-600 hover:underline"
                  >
                    {[c.customer.firstName, c.customer.lastName]
                      .filter(Boolean)
                      .join(" ") || c.customer.email || "Customer"}
                  </Link>
                </td>
                <td>{formatMoneyCents(c.amountCents)}</td>
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
                <td className="text-slate-500 text-xs">
                  {formatDate(c.createdAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card-pad">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>
    </div>
  );
}
