import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { formatMoneyCents } from "@/lib/format";
import { getSession, isSuperAdmin } from "@/lib/session";

export default async function AdminOverviewPage() {
  // The transactions drill-down lists patient names, so only super admins get
  // the clickable stats — billing sees the same numbers, unlinked.
  const canDrillDown = isSuperAdmin(await getSession());
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [clinicCount, customerCount, activePatients, chargeAgg, activeSubs, failed30d] = await Promise.all([
    prisma.clinic.count(),
    prisma.customer.count({ where: { clinicId: { not: null } } }),
    prisma.customer.count({ where: { clinicId: { not: null }, isActive: true } }),
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

  const stats: {
    label: string;
    value: string;
    alert?: boolean;
    href?: string;
  }[] = [
    { label: "Clinics", value: clinicCount.toLocaleString() },
    { label: "Customers", value: customerCount.toLocaleString() },
    { label: "Active patients", value: activePatients.toLocaleString() },
    {
      label: "Transactions",
      value: (chargeAgg._count ?? 0).toLocaleString(),
      href: canDrillDown ? "/admin/transactions?days=all" : undefined,
    },
    { label: "Active subscriptions", value: activeSubs.toLocaleString() },
    { label: "Gross processed", value: formatMoneyCents(gross) },
    { label: "Net (after refunds)", value: formatMoneyCents(net) },
    {
      label: "Failed (30d)",
      value: failed30d.toLocaleString(),
      alert: failed30d > 0,
      href: canDrillDown ? "/admin/transactions?status=failed" : undefined,
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
      {stats.map((s) => {
        const body = (
          <>
            <div className="text-xs text-slate-500">{s.label}</div>
            <div
              className={`mt-1 text-2xl font-semibold ${s.alert ? "text-red-600" : "text-slate-900"}`}
            >
              {s.value}
            </div>
          </>
        );
        return s.href ? (
          <Link
            key={s.label}
            href={s.href}
            className="card-pad hover:border-brand-300 hover:shadow-sm transition"
          >
            {body}
          </Link>
        ) : (
          <div key={s.label} className="card-pad">
            {body}
          </div>
        );
      })}
    </div>
  );
}
