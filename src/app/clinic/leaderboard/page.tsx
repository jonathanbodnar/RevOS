import Link from "next/link";
import { requireClinicAdminContext } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { customerScopeWhere } from "@/lib/roles";
import { formatDateOnly } from "@/lib/csv";
import { LEADERBOARD_METRICS, rankImprovements } from "@/lib/leaderboard";

export const dynamic = "force-dynamic";

/**
 * Clinic leaderboard: patients ranked by InBody improvement, first scan to
 * latest — the good-news counterpart to At-risk patients. Clinic admins (and
 * super admins impersonating) only, like that page.
 */
export default async function LeaderboardPage({
  searchParams,
}: {
  searchParams: Promise<{ metric?: string; showInactive?: string }>;
}) {
  const { session, clinicId } = await requireClinicAdminContext();
  const sp = await searchParams;
  const metric =
    LEADERBOARD_METRICS.find((m) => m.key === sp.metric) ?? LEADERBOARD_METRICS[0];
  const showInactive = sp.showInactive === "1";

  // Dismissed scans never count; undated ones can't be ordered first → latest.
  const scanWhere = { testedAt: { not: null }, dismissedAt: null };
  const customers = await prisma.customer.findMany({
    where: {
      ...customerScopeWhere(session.user, clinicId),
      ...(showInactive ? {} : { isActive: true }),
      inbodyTests: { some: scanWhere },
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      isActive: true,
      inbodyTests: {
        where: scanWhere,
        select: {
          testedAt: true,
          weightKg: true,
          bodyFatMassKg: true,
          percentBodyFat: true,
          skeletalMuscleMassKg: true,
        },
      },
    },
  });

  const { rows, eligible } = rankImprovements(
    customers.map((c) => ({
      id: c.id,
      name:
        [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || "Unnamed",
      scans: c.inbodyTests.map((t) => ({ ...t, testedAt: t.testedAt as Date })),
    })),
    metric,
  );
  const inactiveIds = new Set(customers.filter((c) => !c.isActive).map((c) => c.id));

  const href = (metricKey: string, inactive: boolean) => {
    const qs = new URLSearchParams();
    if (metricKey !== LEADERBOARD_METRICS[0].key) qs.set("metric", metricKey);
    if (inactive) qs.set("showInactive", "1");
    const s = qs.toString();
    return `/clinic/leaderboard${s ? `?${s}` : ""}`;
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Leaderboard</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Patients with the biggest InBody improvements, from their first scan to
          their latest.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-1.5">
          {LEADERBOARD_METRICS.map((m) => (
            <Link
              key={m.key}
              href={href(m.key, showInactive)}
              className={
                m.key === metric.key
                  ? "btn-primary px-3 py-1.5 text-xs"
                  : "btn-secondary px-3 py-1.5 text-xs"
              }
            >
              {m.label}
            </Link>
          ))}
        </div>
        <Link href={href(metric.key, !showInactive)} className="btn-ghost text-sm">
          {showInactive ? "Hide inactive" : "Show inactive"}
        </Link>
      </div>

      {rows.length === 0 ? (
        <div className="card-pad text-center text-slate-500 py-12">
          <p className="text-sm">
            {eligible === 0
              ? "No patients have two InBody scans yet."
              : "No one has improved on this measure yet."}
          </p>
          <p className="text-xs text-slate-400 mt-1">
            Patients appear here once they have at least two InBody scans and
            their latest beats their first.
          </p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="px-5 pt-4 pb-3 text-xs text-slate-500 border-b border-line">
            {metric.description}
          </div>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="w-20">Rank</th>
                  <th>Patient</th>
                  <th className="text-right">{metric.label}</th>
                  <th>First → latest</th>
                  <th className="text-right">Scans</th>
                  <th>Scan dates</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <RankBadge rank={r.rank} />
                    </td>
                    <td>
                      <Link
                        href={`/clinic/customers/${r.id}?tab=inbody`}
                        className="text-brand-600 hover:underline font-medium"
                      >
                        {r.name}
                      </Link>
                      {inactiveIds.has(r.id) && (
                        <span className="badge-slate ml-2 text-[10px]">inactive</span>
                      )}
                    </td>
                    <td className="text-right font-semibold text-emerald-700 tabular-nums whitespace-nowrap">
                      {num(r.improvement)}
                      {metric.changeUnit}
                    </td>
                    <td className="text-slate-600 tabular-nums whitespace-nowrap">
                      {num(r.start)} → {num(r.latest)}
                      {metric.unit}
                    </td>
                    <td className="text-right text-slate-600 tabular-nums">{r.scans}</td>
                    <td className="text-xs text-slate-500 whitespace-nowrap">
                      {/* testedAt holds the device's wall-clock time as UTC, so
                          the UTC date is the date the scan was taken. */}
                      {formatDateOnly(r.firstAt.toISOString())} –{" "}
                      {formatDateOnly(r.latestAt.toISOString())}
                      <div className="text-slate-400">{spanLabel(r.firstAt, r.latestAt)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {eligible > 0 && (
        <p className="text-xs text-slate-400">
          {rows.length} of {eligible} patient{eligible === 1 ? "" : "s"} with two
          or more scans improved on this measure.
        </p>
      )}
    </div>
  );
}

function RankBadge({ rank }: { rank: number }) {
  const medal =
    rank === 1
      ? "bg-amber-100 text-amber-800 ring-1 ring-amber-300"
      : rank === 2
        ? "bg-slate-100 text-slate-700 ring-1 ring-slate-300"
        : rank === 3
          ? "bg-orange-100 text-orange-800 ring-1 ring-orange-300"
          : "text-slate-500";
  return (
    <span
      className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold tabular-nums ${medal}`}
    >
      {rank}
    </span>
  );
}

function num(v: number): string {
  return v.toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function spanLabel(from: Date, to: Date): string {
  const days = Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
  if (days < 14) return `${days} day${days === 1 ? "" : "s"}`;
  return `${Math.round(days / 7)} weeks`;
}
