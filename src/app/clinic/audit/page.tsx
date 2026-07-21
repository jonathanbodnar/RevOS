import { redirect } from "next/navigation";
import { requireClinicContext } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * Clinic-scoped audit log. Clinic admins (and super admins impersonating) see
 * their own clinic's activity only. Providers don't get audit access.
 */
export default async function ClinicAuditPage() {
  const { session, clinicId } = await requireClinicContext();
  if (session.user.originalRole === "PROVIDER") redirect("/clinic");

  const logs = await prisma.auditLog.findMany({
    where: { clinicId },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Audit log</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Every change and patient-record access in this clinic.
        </p>
      </div>
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Actor</th>
                <th>Target</th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 && (
                <tr>
                  <td colSpan={4} className="text-center text-slate-500 py-10">
                    No activity yet.
                  </td>
                </tr>
              )}
              {logs.map((l) => (
                <tr key={l.id}>
                  <td className="text-slate-500 text-xs">
                    {formatDate(l.createdAt)}
                  </td>
                  <td className="font-mono text-xs">{l.action}</td>
                  <td className="text-xs text-slate-700">
                    {l.actorRole}
                    {l.actorId ? ` · ${l.actorId.slice(0, 8)}` : ""}
                  </td>
                  <td className="text-xs text-slate-500">
                    {l.targetType
                      ? `${l.targetType}#${l.targetId?.slice(0, 8)}`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
