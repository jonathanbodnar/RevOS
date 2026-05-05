import { prisma } from "@/lib/prisma";
import { formatDate } from "@/lib/format";

export default async function AuditPage() {
  const logs = await prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    include: { clinic: { select: { name: true } } },
  });

  return (
    <div className="card overflow-hidden">
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>Action</th>
            <th>Actor</th>
            <th>Clinic</th>
            <th>Target</th>
          </tr>
        </thead>
        <tbody>
          {logs.length === 0 && (
            <tr>
              <td colSpan={5} className="text-center text-slate-500 py-10">
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
                {l.actorRole} · {l.actorId?.slice(0, 8) ?? "—"}
              </td>
              <td>{l.clinic?.name ?? "—"}</td>
              <td className="text-xs text-slate-500">
                {l.targetType ? `${l.targetType}#${l.targetId?.slice(0, 8)}` : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
