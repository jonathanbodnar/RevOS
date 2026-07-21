import { requireClinicAdminContext } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { FlagList } from "./flag-list";

export const dynamic = "force-dynamic";

/**
 * Clinic dashboard: at-risk patients flagged by the nightly KPI evaluator,
 * newest first. Clinic admins can resolve or dismiss each flag.
 */
export default async function ClinicReportsPage() {
  const { clinicId } = await requireClinicAdminContext();

  const flags = await prisma.kPIFlag.findMany({
    where: { clinicId, status: "open" },
    orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
    take: 300,
    include: {
      kpi: { select: { name: true, metric: true } },
      customer: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
  });

  const bySeverity = {
    critical: flags.filter((f) => f.severity === "critical").length,
    warn: flags.filter((f) => f.severity === "warn").length,
    info: flags.filter((f) => f.severity === "info").length,
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">At-risk patients</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Patients who tripped a KPI threshold overnight. Resolve a flag once
          you&apos;ve acted on it, or dismiss it if it doesn&apos;t apply.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-4 max-w-lg">
        <Stat label="Critical" value={bySeverity.critical} tone="red" />
        <Stat label="Warning" value={bySeverity.warn} tone="amber" />
        <Stat label="Info" value={bySeverity.info} tone="slate" />
      </div>

      <FlagList
        flags={flags.map((f) => ({
          id: f.id,
          kpiName: f.kpi.name,
          severity: f.severity,
          detail: f.detail,
          customerId: f.customer.id,
          customerName:
            [f.customer.firstName, f.customer.lastName].filter(Boolean).join(" ") ||
            f.customer.email ||
            "Unnamed",
          createdAt: f.createdAt.toISOString(),
        }))}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "red" | "amber" | "slate";
}) {
  const color =
    tone === "red"
      ? "text-red-600"
      : tone === "amber"
        ? "text-amber-600"
        : "text-slate-900";
  return (
    <div className="card-pad">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${color}`}>{value}</div>
    </div>
  );
}
