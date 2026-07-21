import Link from "next/link";
import { requireClinicContext } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { formatDate } from "@/lib/format";
import { toCsv } from "@/lib/csv";
import { DownloadCsvButton } from "@/components/download-csv-button";
import { customerScopeWhere } from "@/lib/roles";

export const dynamic = "force-dynamic";

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; showInactive?: string }>;
}) {
  const { session, clinicId } = await requireClinicContext();
  const sp = await searchParams;
  const q = (sp.q || "").trim();
  const showInactive = sp.showInactive === "1";

  const digits = q.replace(/\D+/g, "");
  // Providers only see their assigned patients; clinic admins see the clinic.
  const scope = customerScopeWhere(session.user, clinicId);
  const customers = await prisma.customer.findMany({
    where: {
      ...scope,
      ...(showInactive ? {} : { isActive: true }),
      ...(q
        ? {
            OR: [
              { firstName: { contains: q, mode: "insensitive" } },
              { lastName: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
              ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { charges: true, paymentMethods: true } } },
  });

  const csv = toCsv(
    [
      "Name",
      "Email",
      "Phone",
      "Status",
      "Payment methods",
      "Transactions",
      "Added",
    ],
    customers.map((c) => [
      [c.firstName, c.lastName].filter(Boolean).join(" ") || "Unnamed",
      c.email,
      c.phone,
      c.isActive ? "active" : "inactive",
      c._count.paymentMethods,
      c._count.charges,
      c.createdAt.toISOString(),
    ]),
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-slate-500">
          {customers.length} customer{customers.length === 1 ? "" : "s"}
          {!showInactive && " (active)"}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <form className="flex items-center gap-2">
            <input
              name="q"
              defaultValue={q}
              className="input w-56"
              placeholder="Search name, email, phone"
            />
            {showInactive && <input type="hidden" name="showInactive" value="1" />}
            <button type="submit" className="btn-secondary text-sm">
              Search
            </button>
          </form>
          <Link
            href={
              showInactive
                ? `/clinic/customers${q ? `?q=${encodeURIComponent(q)}` : ""}`
                : `/clinic/customers?showInactive=1${q ? `&q=${encodeURIComponent(q)}` : ""}`
            }
            className="btn-ghost text-sm"
          >
            {showInactive ? "Hide inactive" : "Show inactive"}
          </Link>
          <DownloadCsvButton csv={csv} filename="customers.csv" />
          {session.user.originalRole !== "PROVIDER" && (
            <Link href="/clinic/customers/new" className="btn-primary">
              + Add customer
            </Link>
          )}
        </div>
      </div>
      <div className="card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Status</th>
              <th>Payment methods</th>
              <th>Transactions</th>
              <th>Added</th>
            </tr>
          </thead>
          <tbody>
            {customers.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-slate-500 py-10">
                  No customers yet.
                </td>
              </tr>
            )}
            {customers.map((c) => (
              <tr key={c.id} className={c.isActive ? undefined : "opacity-60"}>
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
                <td>
                  <span className={c.isActive ? "badge-green" : "badge-slate"}>
                    {c.isActive ? "active" : "inactive"}
                  </span>
                </td>
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
