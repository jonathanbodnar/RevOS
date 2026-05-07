import Link from "next/link";
import { requireClinicContext } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { formatMoneyCents, formatDate } from "@/lib/format";

export default async function ChargesPage() {
  const { clinicId } = await requireClinicContext();
  const charges = await prisma.charge.findMany({
    where: { clinicId },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: { customer: true },
  });
  return (
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
          </tr>
        </thead>
        <tbody>
          {charges.length === 0 && (
            <tr>
              <td colSpan={6} className="text-center text-slate-500 py-10">
                No transactions yet.
              </td>
            </tr>
          )}
          {charges.map((c) => (
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
              <td>{c.refundedCents ? formatMoneyCents(c.refundedCents) : "—"}</td>
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
              <td className="text-slate-500 text-xs">{formatDate(c.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
