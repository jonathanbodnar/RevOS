import { requireSuperAdmin } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { KpisClient } from "./kpis-client";

export const dynamic = "force-dynamic";

export default async function KpisPage() {
  await requireSuperAdmin();
  const [kpis, clinics, openFlags] = await Promise.all([
    prisma.kPI.findMany({
      orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
      include: {
        clinic: { select: { name: true } },
        _count: { select: { flags: { where: { status: "open" } } } },
      },
    }),
    prisma.clinic.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.kPIFlag.count({ where: { status: "open" } }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">KPIs</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Define thresholds that flag at-risk patients nightly. Global KPIs
          apply to every clinic; clinic KPIs to one. {openFlags} open flag
          {openFlags === 1 ? "" : "s"} right now.
        </p>
      </div>
      <KpisClient
        clinics={clinics}
        kpis={kpis.map((k) => ({
          id: k.id,
          name: k.name,
          metric: k.metric,
          comparison: k.comparison,
          threshold: k.threshold,
          windowDays: k.windowDays,
          severity: k.severity,
          isActive: k.isActive,
          clinicName: k.clinic?.name ?? null,
          openFlags: k._count.flags,
        }))}
      />
    </div>
  );
}
