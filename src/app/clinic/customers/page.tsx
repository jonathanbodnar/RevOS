import Link from "next/link";
import { requireClinicContext } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { formatDate } from "@/lib/format";

export default async function CustomersPage() {
  const { clinicId } = await requireClinicContext();
  const customers = await prisma.customer.findMany({
    where: { clinicId },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { charges: true, paymentMethods: true } } },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">
          {customers.length} customer{customers.length === 1 ? "" : "s"}
        </p>
        <Link href="/clinic/customers/new" className="btn-primary">
          + Add customer
        </Link>
      </div>
      <div className="card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Payment methods</th>
              <th>Transactions</th>
              <th>Added</th>
            </tr>
          </thead>
          <tbody>
            {customers.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-slate-500 py-10">
                  No customers yet.
                </td>
              </tr>
            )}
            {customers.map((c) => (
              <tr key={c.id}>
                <td>
                  <Link
                    href={`/clinic/customers/${c.id}`}
                    className="text-brand-600 hover:underline font-medium"
                  >
                    {[c.firstName, c.lastName].filter(Boolean).join(" ") ||
                      "Unnamed"}
                  </Link>
                </td>
                <td className="text-slate-600">{c.email || "—"}</td>
                <td className="text-slate-600">{c.phone || "—"}</td>
                <td>{c._count.paymentMethods}</td>
                <td>{c._count.charges}</td>
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
