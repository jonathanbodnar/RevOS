import { prisma } from "@/lib/prisma";
import { formatMoneyCents } from "@/lib/format";

export default async function AdminOverviewPage() {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [clinicCount, customerCount, chargeAgg, activeSubs, failed30d] = await Promise.all([
    prisma.clinic.count(),
    prisma.customer.count({ where: { clinicId: { not: null } } }),
    prisma.charge.aggregate({
      where: { clinicId: { not: null }, status: { in: ["paid", "pending", "refunded"] } },
      _sum: { amountCents: true, refundedCents: true },
      _count: true,
    }),
    prisma.subscription.count({ where: { status: "active", clinicId: { not: null } } }),
    prisma.charge.count({
      where: { clinicId: { not: null }, status: "failed", createdAt: { gte: thirtyDaysAgo } },
    }),
  ]);

  const gross = chargeAgg._sum.amountCents ?? 0;
  const refunded = chargeAgg._sum.refundedCents ?? 0;
  const net = gross - refunded;

  const stats = [
    { label: "Clinics", value: clinicCount.toLocaleString() },
    { label: "Customers", value: customerCount.toLocaleString() },
    { label: "Transactions", value: (chargeAgg._count ?? 0).toLocaleString() },
    { label: "Active subscriptions", value: activeSubs.toLocaleString() },
    { label: "Gross processed", value: formatMoneyCents(gross) },
    { label: "Net (after refunds)", value: formatMoneyCents(net) },
    { label: "Failed (30d)", value: failed30d.toLocaleString(), alert: failed30d > 0 },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
      {stats.map((s) => (
        <div key={s.label} className="card-pad">
          <div className="text-xs text-slate-500">{s.label}</div>
          <div
            className={`mt-1 text-2xl font-semibold ${s.alert ? "text-red-600" : "text-slate-900"}`}
          >
            {s.value}
          </div>
        </div>
      ))}
    </div>
  );
}
