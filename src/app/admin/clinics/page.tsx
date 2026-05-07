import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { formatDate } from "@/lib/format";
import { ImpersonateButton } from "./impersonate-button";
import { DeleteClinicButton } from "./delete-clinic-button";

export default async function ClinicsListPage() {
  const clinics = await prisma.clinic.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: {
        select: { users: true, customers: true, charges: true },
      },
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500">
          {clinics.length} clinic{clinics.length === 1 ? "" : "s"}
        </p>
        <Link href="/admin/clinics/new" className="btn-primary">
          + New clinic
        </Link>
      </div>

      <div className="card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>Clinic</th>
              <th>Users</th>
              <th>Customers</th>
              <th>Transactions</th>
              <th>Created</th>
              <th className="text-right pr-4">Actions</th>
            </tr>
          </thead>
          <tbody>
            {clinics.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-slate-500 py-10">
                  No clinics yet.{" "}
                  <Link
                    href="/admin/clinics/new"
                    className="text-brand-600 hover:underline"
                  >
                    Create the first one
                  </Link>
                  .
                </td>
              </tr>
            )}
            {clinics.map((c) => (
              <tr key={c.id}>
                <td>
                  <div className="font-medium text-slate-900">{c.name}</div>
                  <div className="text-xs text-slate-500">
                    {c.email || c.slug}
                  </div>
                </td>
                <td>{c._count.users}</td>
                <td>{c._count.customers}</td>
                <td>{c._count.charges}</td>
                <td className="text-slate-500">{formatDate(c.createdAt)}</td>
                <td className="text-right pr-4">
                  <div className="flex items-center justify-end gap-2">
                    <ImpersonateButton clinicId={c.id} />
                    <DeleteClinicButton clinicId={c.id} clinicName={c.name} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
