/**
 * KPI evaluation.
 *
 * A KPI is `flag when <metric> <comparison> <threshold>` over an optional
 * rolling window, scoped to a clinic (or global). The nightly evaluator
 * computes each active KPI's metric per customer and upserts a KPIFlag,
 * idempotent on (kpiId, customerId, evalKey) so re-runs don't duplicate.
 *
 * Supported metrics (extensible — add a case to `computeMetric`):
 *   visit_adherence_pct      completed/scheduled visits × 100 (whole program)
 *   days_since_last_charge   days since the last paid charge
 *   weeks_since_last_scan    weeks since the most recent InBody scan
 *   body_fat_pct_change      latest − earliest %body-fat within the window
 *   weight_change_kg         latest − earliest weight (kg) within the window
 */
import { prisma } from "./prisma";

export type Comparison = "gt" | "gte" | "lt" | "lte";

const DAY_MS = 24 * 60 * 60 * 1000;

function compare(value: number, comparison: string, threshold: number): boolean {
  switch (comparison) {
    case "gt":
      return value > threshold;
    case "gte":
      return value >= threshold;
    case "lt":
      return value < threshold;
    case "lte":
      return value <= threshold;
    default:
      return false;
  }
}

type CustomerData = {
  id: string;
  clinicId: string | null;
  chartWeeks: { scheduled: boolean; completed: boolean }[];
  charges: { createdAt: Date }[]; // paid, newest first
  scans: { testedAt: Date; percentBodyFat: number | null; weightKg: number | null }[]; // newest first
};

function computeMetric(
  metric: string,
  c: CustomerData,
  windowDays: number,
  now: Date,
): number | null {
  const windowStart =
    windowDays > 0 ? new Date(now.getTime() - windowDays * DAY_MS) : null;

  switch (metric) {
    case "visit_adherence_pct": {
      const scheduled = c.chartWeeks.filter((w) => w.scheduled).length;
      if (scheduled === 0) return null;
      const done = c.chartWeeks.filter((w) => w.scheduled && w.completed).length;
      return (done / scheduled) * 100;
    }
    case "days_since_last_charge": {
      const last = c.charges[0]?.createdAt;
      if (!last) return null;
      return (now.getTime() - last.getTime()) / DAY_MS;
    }
    case "weeks_since_last_scan": {
      const last = c.scans[0]?.testedAt;
      if (!last) return null;
      return (now.getTime() - last.getTime()) / (7 * DAY_MS);
    }
    case "body_fat_pct_change":
    case "weight_change_kg": {
      const pick = (s: CustomerData["scans"][number]) =>
        metric === "body_fat_pct_change" ? s.percentBodyFat : s.weightKg;
      const inWindow = c.scans.filter(
        (s) => pick(s) != null && (!windowStart || s.testedAt >= windowStart),
      );
      if (inWindow.length < 2) return null;
      // scans are newest-first: latest − earliest
      const latest = pick(inWindow[0])!;
      const earliest = pick(inWindow[inWindow.length - 1])!;
      return latest - earliest;
    }
    default:
      return null;
  }
}

export type KpiEvalSummary = {
  dryRun: boolean;
  kpisEvaluated: number;
  customersScanned: number;
  flagsRaised: number;
  flagsResolved: number;
  errors: number;
};

export async function evaluateKpis(
  opts: { dryRun?: boolean; now?: Date } = {},
): Promise<KpiEvalSummary> {
  const dryRun = opts.dryRun ?? true;
  const now = opts.now ?? new Date();
  const evalKey = `d:${now.toISOString().slice(0, 10)}`;
  const summary: KpiEvalSummary = {
    dryRun,
    kpisEvaluated: 0,
    customersScanned: 0,
    flagsRaised: 0,
    flagsResolved: 0,
    errors: 0,
  };

  const kpis = await prisma.kPI.findMany({ where: { isActive: true } });

  for (const kpi of kpis) {
    try {
      summary.kpisEvaluated += 1;
      // Customers in scope: a global KPI (clinicId null) covers every clinic's
      // active customers; a clinic KPI covers just that clinic.
      const customers = await prisma.customer.findMany({
        where: {
          isActive: true,
          clinicId: kpi.clinicId ? kpi.clinicId : { not: null },
        },
        select: {
          id: true,
          clinicId: true,
          chartWeeks: { select: { scheduled: true, completed: true } },
          charges: {
            where: { status: { in: ["paid", "refunded", "pending"] } },
            orderBy: { createdAt: "desc" },
            take: 1,
            select: { createdAt: true },
          },
          inbodyTests: {
            where: { testedAt: { not: null } },
            orderBy: { testedAt: "desc" },
            select: { testedAt: true, percentBodyFat: true, weightKg: true },
          },
        },
      });

      for (const cust of customers) {
        summary.customersScanned += 1;
        const data: CustomerData = {
          id: cust.id,
          clinicId: cust.clinicId,
          chartWeeks: cust.chartWeeks,
          charges: cust.charges,
          scans: cust.inbodyTests.map((t) => ({
            testedAt: t.testedAt as Date,
            percentBodyFat: t.percentBodyFat,
            weightKg: t.weightKg,
          })),
        };
        const value = computeMetric(kpi.metric, data, kpi.windowDays, now);
        if (value == null) continue;
        const tripped = compare(value, kpi.comparison, kpi.threshold);

        if (tripped && !dryRun) {
          await prisma.kPIFlag.upsert({
            where: {
              kpiId_customerId_evalKey: {
                kpiId: kpi.id,
                customerId: cust.id,
                evalKey,
              },
            },
            create: {
              kpiId: kpi.id,
              customerId: cust.id,
              clinicId: cust.clinicId,
              value,
              detail: `${kpi.metric} = ${round(value)} (${kpi.comparison} ${kpi.threshold})`,
              severity: kpi.severity,
              evalKey,
            },
            update: { value, severity: kpi.severity },
          });
        }
        if (tripped) summary.flagsRaised += 1;
      }
    } catch (e) {
      summary.errors += 1;
      console.error(`[kpi] evaluation failed for ${kpi.id}`, e);
    }
  }

  return summary;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
