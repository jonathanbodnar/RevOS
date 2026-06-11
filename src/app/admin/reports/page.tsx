import { prisma } from "@/lib/prisma";
import { formatMoneyCents, formatDate } from "@/lib/format";
import {
  resolvePeriod,
  downPaymentEconomics,
  recurringEconomics,
  monthlyFactor,
  type PeriodPreset,
} from "@/lib/reporting";
import { ReportsFilters } from "./reports-filters";
import { ReportActions } from "./report-actions";
import { AdvancedCostForm } from "./advanced-cost-form";
import { DeleteCostButton } from "./delete-cost-button";

export const dynamic = "force-dynamic";

const VALID_PRESETS = ["mtd", "last_month", "ytd", "range", "all"];

function freqLabel(freq: string): string {
  switch (freq) {
    case "weekly":
      return "/wk";
    case "quarterly":
      return "/qtr";
    case "yearly":
      return "/yr";
    default:
      return "/mo";
  }
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{
    preset?: string;
    from?: string;
    to?: string;
    clinicId?: string;
    implementorId?: string;
  }>;
}) {
  const sp = await searchParams;
  const preset = (VALID_PRESETS.includes(sp.preset ?? "") ? sp.preset : "mtd") as PeriodPreset;
  const clinicId = sp.clinicId || "";
  const implementorId = sp.implementorId || "";
  const period = resolvePeriod(preset, sp.from, sp.to);

  // Date window for charges / advanced costs.
  const dateRange =
    period.start && period.end
      ? { gte: period.start, lte: period.end }
      : undefined;

  const chargeWhere = {
    status: { in: ["paid", "refunded"] },
    ...(dateRange ? { createdAt: dateRange } : {}),
  };
  const costWhere = dateRange ? { incurredOn: dateRange } : {};

  // Filter options + lookups.
  const [clinics, implementors, savedReports] = await Promise.all([
    prisma.clinic.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        revosDownPaymentSharePct: true,
        implementorFeeCents: true,
        revosRecurringShareCents: true,
      },
    }),
    prisma.implementor.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, commissionCents: true },
    }),
    prisma.savedReport.findMany({ orderBy: { createdAt: "desc" } }),
  ]);

  const clinicCfg = new Map(clinics.map((c) => [c.id, c]));

  // Customers in scope, with their period-bounded charges, active subs, costs.
  const customers = await prisma.customer.findMany({
    where: {
      clinicId: clinicId ? clinicId : { not: null },
      ...(implementorId ? { implementorId } : {}),
      OR: [
        { charges: { some: chargeWhere } },
        { subscriptions: { some: { status: "active" } } },
        { advancedCosts: { some: costWhere } },
      ],
    },
    include: {
      clinic: { select: { id: true, name: true } },
      implementor: { select: { id: true, name: true, commissionCents: true } },
      charges: { where: chargeWhere, orderBy: { createdAt: "asc" } },
      subscriptions: { where: { status: "active" } },
      advancedCosts: { where: costWhere, orderBy: { incurredOn: "desc" } },
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  // ── Aggregate ──────────────────────────────────────────────────────────
  const t = {
    downCount: 0,
    downGross: 0,
    downBase: 0,
    processingFeeRevenue: 0,
    lunarpayCost: 0,
    revosDownShare: 0,
    clinicDownShare: 0,
    implementorCommission: 0,
    refunds: 0,
    recurringCount: 0,
    recurringMonthlyGross: 0,
    recurringMonthlyBase: 0,
    recurringProcessingFee: 0,
    recurringLunarpayCost: 0,
    revosRecurringShare: 0,
    clinicRecurringShare: 0,
    advancedCosts: 0,
  };

  type Row = {
    id: string;
    name: string;
    clinic: string;
    implementor: string | null;
    downPayments: { amount: number; date: Date }[];
    subs: { amount: number; freq: string; next: Date | null }[];
    refunds: number;
    notes: string | null;
    revosProfit: number;
    clinicProfit: number;
  };
  const rows: Row[] = [];

  for (const cust of customers) {
    const cfg =
      (cust.clinicId && clinicCfg.get(cust.clinicId)) || {
        revosDownPaymentSharePct: 50,
        implementorFeeCents: 14000,
        revosRecurringShareCents: 7500,
      };
    const commissionCents = cust.implementor ? cust.implementor.commissionCents : null;

    let custRevos = 0;
    let custClinic = 0;
    let custRefunds = 0;
    const downPayments: { amount: number; date: Date }[] = [];

    for (const ch of cust.charges) {
      const eco = downPaymentEconomics(ch.amountCents, cfg, commissionCents);
      t.downCount += 1;
      t.downGross += eco.grossCents;
      t.downBase += eco.baseCents;
      t.processingFeeRevenue += eco.processingFeeCents;
      t.lunarpayCost += eco.lunarpayCostCents;
      t.revosDownShare += eco.revosShareCents;
      t.clinicDownShare += eco.clinicShareCents;
      t.implementorCommission += eco.implementorCommissionCents;
      t.refunds += ch.refundedCents;
      custRefunds += ch.refundedCents;
      custRevos += eco.revosProfitCents;
      custClinic += eco.clinicProfitCents;
      downPayments.push({ amount: ch.amountCents, date: ch.createdAt });
    }

    const subs: { amount: number; freq: string; next: Date | null }[] = [];
    for (const s of cust.subscriptions) {
      const eco = recurringEconomics(s.amountCents, cfg);
      const factor = monthlyFactor(s.frequency);
      t.recurringCount += 1;
      t.recurringMonthlyGross += Math.round(eco.grossCents * factor);
      t.recurringMonthlyBase += Math.round(eco.baseCents * factor);
      t.recurringProcessingFee += Math.round(eco.processingFeeCents * factor);
      t.recurringLunarpayCost += Math.round(eco.lunarpayCostCents * factor);
      t.revosRecurringShare += Math.round(eco.revosShareCents * factor);
      t.clinicRecurringShare += Math.round(eco.clinicShareCents * factor);
      custRevos += Math.round(eco.revosProfitCents * factor);
      custClinic += Math.round(eco.clinicProfitCents * factor);
      subs.push({ amount: s.amountCents, freq: s.frequency, next: s.nextPaymentOn });
    }

    // Advanced costs roll into the aggregate RevOS NET, not the per-patient
    // 50/50 share columns.
    for (const ac of cust.advancedCosts) {
      t.advancedCosts += ac.amountCents;
    }

    rows.push({
      id: cust.id,
      name:
        [cust.firstName, cust.lastName].filter(Boolean).join(" ") ||
        cust.email ||
        "Unnamed",
      clinic: cust.clinic?.name ?? "—",
      implementor: cust.implementor?.name ?? null,
      downPayments,
      subs,
      refunds: custRefunds,
      notes: cust.paymentNotes,
      revosProfit: custRevos,
      clinicProfit: custClinic,
    });
  }

  // Clinic-level advanced costs (no customer) in scope, plus per-customer ones.
  const clinicLevelCosts = await prisma.advancedCost.findMany({
    where: {
      customerId: null,
      ...(clinicId ? { clinicId } : { clinicId: { not: null } }),
      ...costWhere,
    },
    include: { clinic: { select: { name: true } } },
    orderBy: { incurredOn: "desc" },
  });
  const allCostsForList = await prisma.advancedCost.findMany({
    where: {
      ...(clinicId ? { clinicId } : { clinicId: { not: null } }),
      ...costWhere,
    },
    include: {
      clinic: { select: { name: true } },
      customer: { select: { firstName: true, lastName: true, email: true } },
    },
    orderBy: { incurredOn: "desc" },
  });
  for (const ac of clinicLevelCosts) t.advancedCosts += ac.amountCents;

  // Headline split: clean 50/50 of the post-fee base (down + recurring).
  const revosShareTotal = t.revosDownShare + t.revosRecurringShare;
  const clinicProfit = t.clinicDownShare + t.clinicRecurringShare;
  // RevOS NET = its share + processing-fee residual − commissions − advanced costs.
  const feeResidual =
    t.processingFeeRevenue +
    t.recurringProcessingFee -
    t.lunarpayCost -
    t.recurringLunarpayCost;
  const revosNet =
    revosShareTotal + feeResidual - t.implementorCommission - t.advancedCosts;

  const filtersJson = JSON.stringify({
    preset,
    from: sp.from ?? "",
    to: sp.to ?? "",
    clinicId,
    implementorId,
  });

  // ── CSV export (per-patient rows + a summary block) ──────────────────────
  const csvEsc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const money = (cents: number) => (cents / 100).toFixed(2);
  const csvLines: string[] = [];
  csvLines.push(`RevOS Report,${csvEsc(period.label)}`);
  csvLines.push(
    `Scope,${csvEsc(clinicId ? clinics.find((c) => c.id === clinicId)?.name ?? "" : "All clinics")}`,
  );
  csvLines.push("");
  csvLines.push(
    [
      "Patient",
      "Clinic",
      "Implementor",
      "Down payments",
      "Down payment dates",
      "Monthly sub",
      "Refunds",
      "Notes",
      "RevOS share",
      "Clinic share",
    ].join(","),
  );
  for (const r of rows) {
    const downTotal = r.downPayments.reduce((s, d) => s + d.amount, 0);
    const downDates = r.downPayments
      .map((d) => formatDate(d.date))
      .join("; ");
    const subStr = r.subs
      .map((s) => `${money(s.amount)}${freqLabel(s.freq)}`)
      .join("; ");
    csvLines.push(
      [
        csvEsc(r.name),
        csvEsc(r.clinic),
        csvEsc(r.implementor ?? ""),
        money(downTotal),
        csvEsc(downDates),
        csvEsc(subStr),
        money(r.refunds),
        csvEsc(r.notes ?? ""),
        money(r.revosProfit),
        money(r.clinicProfit),
      ].join(","),
    );
  }
  csvLines.push("");
  csvLines.push("Summary,Amount");
  csvLines.push(`RevOS share (50%),${money(revosShareTotal)}`);
  csvLines.push(`Clinic share (50%),${money(clinicProfit)}`);
  csvLines.push(`RevOS net (after fees & costs),${money(revosNet)}`);
  csvLines.push(`Down payments gross,${money(t.downGross)}`);
  csvLines.push(`Recurring monthly gross,${money(t.recurringMonthlyGross)}`);
  csvLines.push(`Refunds,${money(t.refunds)}`);
  csvLines.push(`Implementor commissions,${money(t.implementorCommission)}`);
  csvLines.push(`Advanced costs,${money(t.advancedCosts)}`);
  const csv = csvLines.join("\n");
  const csvFilename = `revos-report-${preset}-${new Date().toISOString().slice(0, 10)}.csv`;

  const summary: { label: string; value: string; sub?: string; accent?: boolean }[] = [
    { label: "RevOS share (50%)", value: formatMoneyCents(revosShareTotal), accent: true },
    { label: "Clinic share (50%)", value: formatMoneyCents(clinicProfit) },
    {
      label: "RevOS net",
      value: formatMoneyCents(revosNet),
      sub: "after fees, commissions & costs",
    },
    {
      label: "Down payments",
      value: formatMoneyCents(t.downGross),
      sub: `${t.downCount} payment${t.downCount === 1 ? "" : "s"}`,
    },
    {
      label: "Recurring (monthly)",
      value: formatMoneyCents(t.recurringMonthlyGross),
      sub: `${t.recurringCount} active sub${t.recurringCount === 1 ? "" : "s"} · projected`,
    },
    { label: "Refunds", value: formatMoneyCents(t.refunds) },
    { label: "Advanced costs", value: formatMoneyCents(t.advancedCosts) },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Reporting center</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Revenue share, implementor commissions &amp; profit across all clinics.
          </p>
        </div>
        <ReportActions
          filtersJson={filtersJson}
          csv={csv}
          csvFilename={csvFilename}
          savedReports={savedReports.map((r) => ({
            id: r.id,
            name: r.name,
            filtersJson: r.filtersJson,
          }))}
        />
      </div>

      <ReportsFilters
        clinics={clinics.map((c) => ({ id: c.id, name: c.name }))}
        implementors={implementors.map((i) => ({ id: i.id, name: i.name }))}
        current={{
          preset,
          from: sp.from ?? "",
          to: sp.to ?? "",
          clinicId,
          implementorId,
        }}
      />

      {/* Printable report */}
      <div id="report-print" className="space-y-6">
        <div className="hidden print:block">
          <h1 className="text-lg font-bold">RevOS Report — {period.label}</h1>
          <p className="text-sm text-slate-500">
            {clinicId ? clinics.find((c) => c.id === clinicId)?.name : "All clinics"}
            {implementorId
              ? ` · ${implementors.find((i) => i.id === implementorId)?.name}`
              : ""}
          </p>
        </div>

        <div className="text-xs text-slate-500 print-hidden">
          Period: <span className="font-medium text-slate-700">{period.label}</span>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {summary.map((s) => (
            <div
              key={s.label}
              className={`card-pad ${s.accent ? "ring-2 ring-brand-900/10" : ""}`}
            >
              <div className="text-xs text-slate-500">{s.label}</div>
              <div className="mt-1 text-2xl font-semibold text-slate-900">{s.value}</div>
              {s.sub && <div className="text-xs text-slate-400 mt-0.5">{s.sub}</div>}
            </div>
          ))}
        </div>

        {/* Profit breakdown */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="card-pad space-y-2">
            <h3 className="text-sm font-semibold text-slate-900 mb-2">
              Down payment revenue share
            </h3>
            <BreakdownRow label="Gross collected" value={t.downGross} />
            <BreakdownRow label="Base (fee removed)" value={t.downBase} muted />
            <BreakdownRow label="RevOS share (50%)" value={t.revosDownShare} />
            <BreakdownRow label="Clinic share (50%)" value={t.clinicDownShare} />
            <BreakdownRow label="Processing fees (RevOS revenue)" value={t.processingFeeRevenue} />
            <BreakdownRow label="LunarPay fees (cost)" value={-t.lunarpayCost} negative />
            <BreakdownRow label="Implementor commissions (cost)" value={-t.implementorCommission} negative />
          </div>

          <div className="card-pad space-y-2">
            <h3 className="text-sm font-semibold text-slate-900 mb-2">
              Recurring revenue (monthly, projected)
            </h3>
            <BreakdownRow label="Monthly recurring gross" value={t.recurringMonthlyGross} />
            <BreakdownRow label="Base (fee removed)" value={t.recurringMonthlyBase} muted />
            <BreakdownRow label="RevOS share (50%)" value={t.revosRecurringShare} />
            <BreakdownRow label="Clinic share (50%)" value={t.clinicRecurringShare} />
            <BreakdownRow label="Processing fees (RevOS revenue)" value={t.recurringProcessingFee} />
            <BreakdownRow label="LunarPay fees (cost)" value={-t.recurringLunarpayCost} negative />
          </div>
        </div>

        {/* Per-patient table */}
        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-line flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">
              Patients · {rows.length}
            </h3>
          </div>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Patient</th>
                  <th>Clinic</th>
                  <th>Implementor</th>
                  <th>Down payment(s)</th>
                  <th>Monthly sub</th>
                  <th>Refunds</th>
                  <th>Notes</th>
                  <th className="text-right">RevOS</th>
                  <th className="text-right">Clinic</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="text-center text-slate-500 py-8">
                      No activity in this period.
                    </td>
                  </tr>
                )}
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="font-medium text-slate-900">{r.name}</td>
                    <td className="text-slate-600">{r.clinic}</td>
                    <td className="text-slate-600">{r.implementor ?? "—"}</td>
                    <td>
                      {r.downPayments.length === 0 ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <div className="space-y-0.5">
                          {r.downPayments.map((d, i) => (
                            <div key={i} className="text-xs">
                              {formatMoneyCents(d.amount)}
                              <span className="text-slate-400"> · {formatDate(d.date)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>
                      {r.subs.length === 0 ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <div className="space-y-0.5">
                          {r.subs.map((s, i) => (
                            <div key={i} className="text-xs">
                              {formatMoneyCents(s.amount)}
                              <span className="text-slate-400">{freqLabel(s.freq)}</span>
                              {s.next && (
                                <span className="text-slate-400"> · next {formatDate(s.next)}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="text-slate-600">
                      {r.refunds > 0 ? formatMoneyCents(r.refunds) : "—"}
                    </td>
                    <td className="text-slate-500 text-xs max-w-[180px]">
                      {r.notes || "—"}
                    </td>
                    <td className="text-right font-medium text-slate-900">
                      {formatMoneyCents(r.revosProfit)}
                    </td>
                    <td className="text-right text-slate-600">
                      {formatMoneyCents(r.clinicProfit)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Advanced costs */}
        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-line flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Approved supplement &amp; program costs advanced by RevOS
              </h3>
              <p className="text-xs text-slate-500">
                Total {formatMoneyCents(t.advancedCosts)} · subtracted from RevOS profit
              </p>
            </div>
            <AdvancedCostForm clinics={clinics.map((c) => ({ id: c.id, name: c.name }))} />
          </div>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Clinic</th>
                  <th>Patient</th>
                  <th>Category</th>
                  <th>Description</th>
                  <th className="text-right">Amount</th>
                  <th className="text-right print-hidden">·</th>
                </tr>
              </thead>
              <tbody>
                {allCostsForList.length === 0 && (
                  <tr>
                    <td colSpan={7} className="text-center text-slate-500 py-6">
                      No advanced costs in this period.
                    </td>
                  </tr>
                )}
                {allCostsForList.map((ac) => (
                  <tr key={ac.id}>
                    <td className="text-slate-600">{formatDate(ac.incurredOn)}</td>
                    <td className="text-slate-600">{ac.clinic?.name ?? "—"}</td>
                    <td className="text-slate-600">
                      {ac.customer
                        ? [ac.customer.firstName, ac.customer.lastName]
                            .filter(Boolean)
                            .join(" ") || ac.customer.email || "—"
                        : "Clinic-wide"}
                    </td>
                    <td>
                      <span className="badge-slate capitalize">{ac.category}</span>
                    </td>
                    <td className="text-slate-700">{ac.description}</td>
                    <td className="text-right font-medium">{formatMoneyCents(ac.amountCents)}</td>
                    <td className="text-right print-hidden">
                      <DeleteCostButton id={ac.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <p className="text-[11px] text-slate-400">
          Processing fees reflect the customer-facing 3.9% + $0.39 (RevOS revenue) and a
          separate LunarPay 3.9% + $0.39 (cost). Recurring figures are projected from
          active subscriptions, not individual historical charges.
        </p>
      </div>
    </div>
  );
}

function BreakdownRow({
  label,
  value,
  muted,
  negative,
}: {
  label: string;
  value: number;
  muted?: boolean;
  negative?: boolean;
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className={muted ? "text-slate-400" : "text-slate-600"}>{label}</span>
      <span
        className={
          negative ? "text-red-600 font-medium" : muted ? "text-slate-400" : "text-slate-900 font-medium"
        }
      >
        {formatMoneyCents(value)}
      </span>
    </div>
  );
}
