import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { formatMoneyCents } from "@/lib/format";
import { WipeTestDataButton } from "./wipe-button";

export default async function AdminOverviewPage() {
  const [clinicCount, customerCount, chargeAgg, activeSubs] = await Promise.all([
    prisma.clinic.count(),
    prisma.customer.count(),
    prisma.charge.aggregate({
      _sum: { amountCents: true, refundedCents: true },
      _count: true,
    }),
    prisma.subscription.count({ where: { status: "active" } }),
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
  ];

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <WipeTestDataButton />
      </div>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
        {stats.map((s) => (
          <div key={s.label} className="card-pad">
            <div className="text-xs text-slate-500">{s.label}</div>
            <div className="mt-1 text-2xl font-semibold text-slate-900">
              {s.value}
            </div>
          </div>
        ))}
      </div>

      <div className="card-pad">
        <h2 className="text-sm font-semibold text-slate-900 mb-3">
          Getting started
        </h2>
        <ol className="text-sm text-slate-700 space-y-2 list-decimal list-inside">
          <li>
            <Link href="/admin/clinics/new" className="text-brand-600 hover:underline">
              Create a clinic
            </Link>{" "}
            and its initial admin account.
          </li>
          <li>Share credentials with the clinic admin, or use the “Login as clinic” button to set it up for them.</li>
          <li>All payments flow through the single LunarPay merchant configured in <code>.env</code>.</li>
        </ol>
      </div>
    </div>
  );
}
