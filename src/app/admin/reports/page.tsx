import { prisma } from "@/lib/prisma";
import { formatMoneyCents, formatDate } from "@/lib/format";
import {
  resolvePeriod,
  downPaymentEconomics,
  recurringEconomics,
  careCreditEconomics,
  netChargeAmountCents,
  type PeriodPreset,
} from "@/lib/reporting";
import {
  parsePaymentsJson,
  formatDateOnly,
  csvEsc,
  csvMoney,
} from "@/lib/csv";
import { ReportsFilters } from "./reports-filters";
import { ReportActions } from "./report-actions";
import { AdvancedCostForm } from "./advanced-cost-form";
import { DeleteCostButton } from "./delete-cost-button";
import { ClinicPayoutForm } from "./clinic-payout-form";
import { DeletePayoutButton } from "./delete-payout-button";

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
  const now = new Date();
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
  const careCreditWhere = dateRange ? { collectedOn: dateRange } : {};
  const payoutWhere = dateRange ? { paidOn: dateRange } : {};

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

  // Failed payments in scope (declines on manual charges, links, renewals,
  // installments). Never counted toward revenue — surfaced as a risk metric.
  const failedAgg = await prisma.charge.aggregate({
    where: {
      clinicId: clinicId ? clinicId : { not: null },
      status: "failed",
      ...(dateRange ? { createdAt: dateRange } : {}),
      ...(implementorId ? { customer: { implementorId } } : {}),
    },
    _sum: { amountCents: true },
    _count: true,
  });
  const failedCount = failedAgg._count ?? 0;
  const failedAmountCents = failedAgg._sum.amountCents ?? 0;

  // Scope filter shared by the patient-level metrics (clinic + implementor,
  // independent of the period window).
  const scopeCustomerWhere = {
    clinicId: clinicId ? clinicId : { not: null },
    ...(implementorId ? { implementorId } : {}),
  };

  // Patient-level metrics: active patients, patients sold per week, and time
  // on program all need charge history OUTSIDE the selected period (a patient
  // sold in March is still week 18 on program in July), so pull a minimal
  // all-time charge list for the scope.
  const [activePatientCount, allTimeCharges, allTimeCareCredits] =
    await Promise.all([
      prisma.customer.count({
        where: { ...scopeCustomerWhere, isActive: true },
      }),
      prisma.charge.findMany({
        where: {
          status: { in: ["paid", "refunded"] },
          customer: scopeCustomerWhere,
        },
        select: {
          customerId: true,
          createdAt: true,
          description: true,
          amountCents: true,
          refundedCents: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      // Care credits are sales too (financed externally, no Charge row).
      prisma.careCredit.findMany({
        where: { customer: scopeCustomerWhere },
        select: { customerId: true, collectedOn: true },
      }),
    ]);

  // First non-recurring collection = the sale that put the patient on program.
  // Fully-refunded charges kept no money, so they anchor nothing (matching how
  // every revenue metric nets them to zero).
  const RECURRING_RE = /subscription renewal/i;
  const firstSaleByCustomer = new Map<string, Date>();
  const firstAnyByCustomer = new Map<string, Date>();
  const lastPaidByCustomer = new Map<string, Date>();
  for (const ch of allTimeCharges) {
    if (netChargeAmountCents(ch.amountCents, ch.refundedCents) <= 0) continue;
    if (!firstAnyByCustomer.has(ch.customerId)) {
      firstAnyByCustomer.set(ch.customerId, ch.createdAt);
    }
    if (
      !RECURRING_RE.test(ch.description || "") &&
      !firstSaleByCustomer.has(ch.customerId)
    ) {
      firstSaleByCustomer.set(ch.customerId, ch.createdAt);
    }
    lastPaidByCustomer.set(ch.customerId, ch.createdAt);
  }
  for (const cc of allTimeCareCredits) {
    const first = firstSaleByCustomer.get(cc.customerId);
    if (!first || cc.collectedOn < first) {
      firstSaleByCustomer.set(cc.customerId, cc.collectedOn);
    }
    const firstAny = firstAnyByCustomer.get(cc.customerId);
    if (!firstAny || cc.collectedOn < firstAny) {
      firstAnyByCustomer.set(cc.customerId, cc.collectedOn);
    }
    const last = lastPaidByCustomer.get(cc.customerId);
    if (!last || cc.collectedOn > last) {
      lastPaidByCustomer.set(cc.customerId, cc.collectedOn);
    }
  }
  const saleDates = new Map<string, Date>();
  for (const [cid, d] of firstAnyByCustomer) {
    saleDates.set(cid, firstSaleByCustomer.get(cid) ?? d);
  }

  // Patients sold in the selected period, averaged per week. The denominator
  // window must match the bounds the numerator applied — a half-open custom
  // range falls back to first-sale/now on the missing side only.
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const allSaleDates = [...saleDates.values()];
  const soldInPeriod = allSaleDates.filter(
    (d) =>
      (!period.start || d >= period.start) && (!period.end || d <= period.end),
  ).length;
  const spanStart =
    period.start ??
    (allSaleDates.length > 0
      ? new Date(Math.min(...allSaleDates.map((d) => d.getTime())))
      : null);
  const spanEnd = period.end ?? now;
  const periodSpanMs = spanStart
    ? Math.max(0, spanEnd.getTime() - spanStart.getTime())
    : 0;
  const periodWeeks = Math.max(1, periodSpanMs / WEEK_MS);
  const avgSoldPerWeek = soldInPeriod / periodWeeks;

  // ── Program-chart KPIs (adherence) ───────────────────────────────────────
  // Chart weeks are program-relative, not period-bounded, so they honor the
  // clinic/implementor scope but not the date window. Adherence = the share of
  // scheduled visits that were completed.
  const chartWeeksInScope = await prisma.chartWeek.findMany({
    where: { customer: scopeCustomerWhere },
    select: {
      customerId: true,
      weekNumber: true,
      scheduled: true,
      completed: true,
      progressNotes: true,
    },
  });
  const chart = {
    scheduled: 0,
    completed: 0,
    // Completed AND scheduled — the adherence numerator. Counting completed
    // independently of scheduled lets adherence exceed 100%.
    completedOfScheduled: 0,
    notes: 0,
    patients: new Set<string>(),
  };
  const chartByWeekNum = new Map<
    number,
    { scheduled: number; completed: number; completedOfScheduled: number }
  >();
  for (const w of chartWeeksInScope) {
    const hasNotes = !!(w.progressNotes && w.progressNotes.trim());
    if (w.scheduled) chart.scheduled += 1;
    if (w.completed) chart.completed += 1;
    if (w.scheduled && w.completed) chart.completedOfScheduled += 1;
    if (hasNotes) chart.notes += 1;
    if (w.scheduled || w.completed || hasNotes) chart.patients.add(w.customerId);
    const b =
      chartByWeekNum.get(w.weekNumber) ??
      { scheduled: 0, completed: 0, completedOfScheduled: 0 };
    if (w.scheduled) b.scheduled += 1;
    if (w.completed) b.completed += 1;
    if (w.scheduled && w.completed) b.completedOfScheduled += 1;
    chartByWeekNum.set(w.weekNumber, b);
  }
  const chartAdherence =
    chart.scheduled > 0 ? chart.completedOfScheduled / chart.scheduled : null;
  const chartPatientCount = chart.patients.size;
  const chartWeekBreakdown = [...chartByWeekNum.entries()]
    .map(([weekNumber, v]) => ({
      weekNumber,
      scheduled: v.scheduled,
      completed: v.completed,
      adherence:
        v.scheduled > 0 ? v.completedOfScheduled / v.scheduled : null,
    }))
    .sort((a, b) => a.weekNumber - b.weekNumber);

  // Customers in scope, with their period-bounded charges, active subs, costs.
  const customers = await prisma.customer.findMany({
    where: {
      clinicId: clinicId ? clinicId : { not: null },
      ...(implementorId ? { implementorId } : {}),
      OR: [
        { charges: { some: chargeWhere } },
        { subscriptions: { some: { status: "active" } } },
        { schedules: { some: { status: { in: ["active", "completed"] } } } },
        { advancedCosts: { some: costWhere } },
        { careCredits: { some: careCreditWhere } },
      ],
    },
    include: {
      clinic: { select: { id: true, name: true } },
      implementor: { select: { id: true, name: true, commissionCents: true } },
      charges: { where: chargeWhere, orderBy: { createdAt: "asc" } },
      subscriptions: { where: { status: "active" } },
      schedules: {
        where: { status: { in: ["active", "completed", "cancelled"] } },
        orderBy: { createdAt: "desc" },
      },
      advancedCosts: { where: costWhere, orderBy: { incurredOn: "desc" } },
      careCredits: { where: careCreditWhere, orderBy: { collectedOn: "desc" } },
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
    careCreditTotal: 0,
    careCreditCount: 0,
    careCreditRevosShare: 0,
    careCreditClinicShare: 0,
  };

  // Per-clinic ledger for the balance RevOS owes each clinic:
  //   balance = clinic share of RevOS-collected money
  //           − RevOS's share of care credits (clinic already holds that cash)
  //           − payouts already remitted.
  const clinicLedger = new Map<
    string,
    {
      name: string;
      clinicCollectedShare: number;
      careCreditRevosTake: number;
      payouts: number;
      // True down payments only (not installments/renewals) — for the
      // per-clinic average down payment.
      downGross: number;
      downCount: number;
    }
  >();
  const ledgerFor = (cid: string | null, name: string) => {
    if (!cid) return null;
    let row = clinicLedger.get(cid);
    if (!row) {
      row = {
        name,
        clinicCollectedShare: 0,
        careCreditRevosTake: 0,
        payouts: 0,
        downGross: 0,
        downCount: 0,
      };
      clinicLedger.set(cid, row);
    }
    return row;
  };

  type Row = {
    id: string;
    name: string;
    clinic: string;
    implementor: string | null;
    downPayments: {
      amount: number;
      date: Date;
      kind: "down" | "installment" | "other";
      // The date the payment was originally scheduled for, when the charge
      // came from a payment schedule (parsed from the description marker).
      scheduledFor: string | null;
    }[];
    subs: { amount: number; freq: string; next: Date | null; pending: boolean }[];
    scheduled: {
      status: string;
      // Single-payment schedules are one-time scheduled charges, not
      // installment plans — labeled differently in UI/CSV.
      oneTime: boolean;
      payments: { amount: number; date: string; status?: string }[];
    }[];
    careCredits: { amount: number; date: Date; note: string | null }[];
    refunds: number;
    notes: string | null;
    // Weeks on program: week 1 starts at the first (non-recurring) charge.
    programWeeks: number | null;
    programActive: boolean;
    revosProfit: number;
    clinicProfit: number;
  };
  const rows: Row[] = [];

  // "Installment payment (scheduled 2026-08-01)" / "(reconciled 2026-08-01)"
  // markers written by the webhook and the schedule reconciler.
  const SCHEDULED_FOR_RE = /\((?:scheduled|reconciled) (\d{4}-\d{2}-\d{2})\)/;

  function chargeKind(
    description: string | null,
  ): "down" | "installment" | "other" {
    const d = (description || "").toLowerCase();
    if (d.includes("installment")) return "installment";
    if (
      d.includes("subscription") ||
      d.includes("recurring") ||
      d.includes("(auto)")
    ) {
      return "other";
    }
    return "down";
  }

  for (const cust of customers) {
    const cfg =
      (cust.clinicId && clinicCfg.get(cust.clinicId)) || {
        revosDownPaymentSharePct: 50,
        implementorFeeCents: 14000,
        revosRecurringShareCents: 7500,
      };
    const commissionCents = cust.implementor ? cust.implementor.commissionCents : null;

    const ledger = ledgerFor(cust.clinicId, cust.clinic?.name ?? "—");

    let custRevos = 0;
    let custClinic = 0;
    let custRefunds = 0;
    const downPayments: {
      amount: number;
      date: Date;
      kind: "down" | "installment" | "other";
      scheduledFor: string | null;
    }[] = [];

    for (const ch of cust.charges) {
      // LunarPay reports refunds against the original transaction. Revenue
      // share and clinic balances must therefore use the amount that remains
      // collected, not the original pre-refund gross.
      const netAmountCents = netChargeAmountCents(
        ch.amountCents,
        ch.refundedCents,
      );
      // Recurring/subscription charges (real Charge rows, now backfilled +
      // kept current by the webhook/reconciliation) are counted as ACTUAL
      // recurring revenue for the selected period — no longer projected from
      // the Subscription table. Match the exact "Subscription renewal" marker
      // the webhook/reconciliation use, so a down payment merely described as
      // e.g. "Down payment + monthly subscription" is NOT misclassified.
      const isRecurring = /subscription renewal/.test(
        (ch.description || "").toLowerCase(),
      );
      if (isRecurring) {
        const eco = recurringEconomics(netAmountCents, cfg);
        t.recurringCount += 1;
        t.recurringMonthlyGross += eco.grossCents;
        t.recurringMonthlyBase += eco.baseCents;
        t.recurringProcessingFee += eco.processingFeeCents;
        t.recurringLunarpayCost += eco.lunarpayCostCents;
        t.revosRecurringShare += eco.revosShareCents;
        t.clinicRecurringShare += eco.clinicShareCents;
        t.refunds += ch.refundedCents;
        custRefunds += ch.refundedCents;
        custRevos += eco.revosProfitCents;
        custClinic += eco.clinicProfitCents;
        if (ledger) ledger.clinicCollectedShare += eco.clinicShareCents;
        continue;
      }

      const eco = downPaymentEconomics(
        netAmountCents,
        cfg,
        netAmountCents > 0 ? commissionCents : null,
      );
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
      if (ledger) ledger.clinicCollectedShare += eco.clinicShareCents;
      if (netAmountCents > 0) {
        const kind = chargeKind(ch.description);
        if (ledger && kind === "down") {
          ledger.downGross += netAmountCents;
          ledger.downCount += 1;
        }
        downPayments.push({
          amount: netAmountCents,
          date: ch.createdAt,
          kind,
          scheduledFor: SCHEDULED_FOR_RE.exec(ch.description ?? "")?.[1] ?? null,
        });
      }
    }

    const scheduled = cust.schedules.map((s) => {
      const payments = parsePaymentsJson(s.paymentsJson);
      // One-time = a single scheduled item that IS the whole plan. A
      // rescheduled multi-item plan can have a 1-item snapshot but its total
      // still covers the full package, so require the totals to agree.
      const oneTime =
        payments.length === 1 &&
        s.totalAmountCents === Math.round(payments[0].amount);
      return { status: s.status, oneTime, payments };
    });

    // Subscriptions are shown for context (plan amount + next charge date), but
    // recurring REVENUE now comes from the real recurring Charge rows above —
    // not projected here — so a sub contributes to totals only when it actually
    // bills. `pending` still flags a sub whose first charge hasn't happened yet.
    const subs: { amount: number; freq: string; next: Date | null; pending: boolean }[] = [];
    for (const s of cust.subscriptions) {
      const firstCharge = s.nextPaymentOn ?? s.startOn ?? null;
      const hasCollected = firstCharge != null && firstCharge.getTime() <= now.getTime();
      subs.push({
        amount: s.amountCents,
        freq: s.frequency,
        next: s.nextPaymentOn,
        pending: !hasCollected,
      });
    }

    // Care credits: split like a down payment (no fee). Counts in the share
    // columns, but RevOS's share is OWED by the clinic, so it reduces the
    // clinic balance rather than adding to it.
    const careCredits: { amount: number; date: Date; note: string | null }[] = [];
    for (const cc of cust.careCredits) {
      const eco = careCreditEconomics(cc.amountCents, cfg);
      t.careCreditTotal += cc.amountCents;
      t.careCreditCount += 1;
      t.careCreditRevosShare += eco.revosShareCents;
      t.careCreditClinicShare += eco.clinicShareCents;
      custRevos += eco.revosShareCents;
      custClinic += eco.clinicShareCents;
      if (ledger) ledger.careCreditRevosTake += eco.revosShareCents;
      careCredits.push({ amount: cc.amountCents, date: cc.collectedOn, note: cc.note });
    }

    // Advanced costs roll into the aggregate RevOS NET, not the per-patient
    // 50/50 share columns.
    for (const ac of cust.advancedCosts) {
      t.advancedCosts += ac.amountCents;
    }

    // Time on program: week 1 begins at the sale (first non-recurring charge).
    // Active patients count up to today; ended patients stop at their last
    // collected charge. Week numbers align with "week N" InBody scans.
    const startedOn = saleDates.get(cust.id) ?? null;
    const programActive =
      cust.isActive &&
      (cust.subscriptions.length > 0 ||
        cust.schedules.some((s) => s.status === "active"));
    const programEnd = programActive
      ? now
      : (lastPaidByCustomer.get(cust.id) ?? startedOn);
    const programWeeks =
      startedOn && programEnd
        ? Math.max(
            1,
            Math.floor((programEnd.getTime() - startedOn.getTime()) / WEEK_MS) + 1,
          )
        : null;

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
      scheduled,
      careCredits,
      refunds: custRefunds,
      notes: cust.paymentNotes,
      programWeeks,
      programActive,
      revosProfit: custRevos,
      clinicProfit: custClinic,
    });
  }

  // "Currently billing" cohort: derived from the same rows the table shows
  // (the customers query's OR pulls in every active-sub/active-schedule
  // patient regardless of period), so the card and the table agree.
  const activeBillingCount = rows.filter((r) => r.programActive).length;
  const activeDurations = rows
    .filter((r) => r.programActive && r.programWeeks != null)
    .map((r) => r.programWeeks as number);
  const avgProgramWeeks =
    activeDurations.length > 0
      ? activeDurations.reduce((s, w) => s + w, 0) / activeDurations.length
      : null;

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

  // Clinic payouts in scope — fold into the ledger and keep a list for display.
  const payouts = await prisma.clinicPayout.findMany({
    where: {
      ...(clinicId ? { clinicId } : {}),
      ...payoutWhere,
    },
    include: { clinic: { select: { id: true, name: true } } },
    orderBy: { paidOn: "desc" },
  });
  let payoutsTotal = 0;
  for (const p of payouts) {
    payoutsTotal += p.amountCents;
    const row = ledgerFor(p.clinicId, p.clinic?.name ?? "—");
    if (row) row.payouts += p.amountCents;
  }

  // Clinic balances (what RevOS still owes each clinic) within scope.
  const clinicBalances = Array.from(clinicLedger.entries())
    .map(([id, v]) => ({
      id,
      name: v.name,
      clinicCollectedShare: v.clinicCollectedShare,
      careCreditRevosTake: v.careCreditRevosTake,
      payouts: v.payouts,
      downCount: v.downCount,
      avgDownPaymentCents:
        v.downCount > 0 ? Math.round(v.downGross / v.downCount) : null,
      balanceDue: v.clinicCollectedShare - v.careCreditRevosTake - v.payouts,
    }))
    .sort((a, b) => b.balanceDue - a.balanceDue);
  const totalBalanceDue = clinicBalances.reduce((s, c) => s + c.balanceDue, 0);

  // Headline split: post-fee base split (down + recurring) plus care credit.
  const revosShareTotal =
    t.revosDownShare + t.revosRecurringShare + t.careCreditRevosShare;
  const clinicProfit =
    t.clinicDownShare + t.clinicRecurringShare + t.careCreditClinicShare;
  // RevOS NET = its share + processing-fee residual − commissions − advanced costs.
  // (Care-credit RevOS share is already in revosShareTotal; it carries no fees.)
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
  const money = csvMoney;
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
      "On program (wks)",
      "Program status",
      "Down payments",
      "Down payment dates",
      "Monthly sub",
      "Scheduled payments",
      "Care credit",
      "Refunds",
      "Notes",
      "RevOS share",
      "Clinic share",
    ].join(","),
  );
  for (const r of rows) {
    const downTotal = r.downPayments.reduce((s, d) => s + d.amount, 0);
    const downDates = r.downPayments
      .map((d) => {
        const label =
          d.kind === "installment"
            ? "scheduled installment"
            : d.kind === "other"
              ? "other"
              : "down";
        const schedFor = d.scheduledFor
          ? ` scheduled for ${formatDateOnly(d.scheduledFor)}`
          : "";
        return `${formatDate(d.date)} [${label}${schedFor}]`;
      })
      .join("; ");
    const subStr = r.subs
      .map((s) => {
        const next = s.next
          ? ` scheduled ${formatDateOnly(s.next.toISOString().slice(0, 10))}`
          : "";
        return `${money(s.amount)}${freqLabel(s.freq)}${s.pending ? " (pending)" : ""}${next}`;
      })
      .join("; ");
    const schedStr = r.scheduled
      .map((s) => {
        const dates = s.payments
          .map(
            (p) =>
              `${formatDateOnly(p.date)} ${money(p.amount)}${p.status ? ` ${p.status}` : ""}`,
          )
          .join(" | ");
        const label = s.oneTime ? "one-time scheduled" : "installments";
        return `${label} (${s.status}): ${dates || "no dates stored"}`;
      })
      .join("; ");
    const ccTotal = r.careCredits.reduce((s, c) => s + c.amount, 0);
    csvLines.push(
      [
        csvEsc(r.name),
        csvEsc(r.clinic),
        csvEsc(r.implementor ?? ""),
        r.programWeeks != null ? String(r.programWeeks) : "",
        r.programWeeks != null ? (r.programActive ? "active" : "ended") : "",
        money(downTotal),
        csvEsc(downDates),
        csvEsc(subStr),
        csvEsc(schedStr),
        ccTotal > 0 ? money(ccTotal) : "",
        money(r.refunds),
        csvEsc(r.notes ?? ""),
        money(r.revosProfit),
        money(r.clinicProfit),
      ].join(","),
    );
  }
  csvLines.push("");
  csvLines.push("Summary,Amount");
  csvLines.push(`RevOS share,${money(revosShareTotal)}`);
  csvLines.push(`Clinic share,${money(clinicProfit)}`);
  csvLines.push(`RevOS net (after fees & costs),${money(revosNet)}`);
  csvLines.push(`Active patients,${activePatientCount}`);
  csvLines.push(`Active patients currently billing,${activeBillingCount}`);
  csvLines.push(`Patients sold in period,${soldInPeriod}`);
  csvLines.push(`Avg patients sold per week,${avgSoldPerWeek.toFixed(2)}`);
  csvLines.push(
    `Avg time on program (weeks),${avgProgramWeeks != null ? avgProgramWeeks.toFixed(1) : ""}`,
  );
  csvLines.push(`Patients with a program chart,${chartPatientCount}`);
  csvLines.push(`Visits scheduled,${chart.scheduled}`);
  csvLines.push(`Visits completed,${chart.completed}`);
  csvLines.push(
    `Visit adherence,${chartAdherence != null ? `${Math.round(chartAdherence * 100)}%` : ""}`,
  );
  csvLines.push(`Progress notes logged,${chart.notes}`);
  if (chartWeekBreakdown.length > 0) {
    csvLines.push("");
    csvLines.push("Program week,Scheduled,Completed,Adherence (program-to-date)");
    for (const w of chartWeekBreakdown) {
      csvLines.push(
        `Week ${w.weekNumber},${w.scheduled},${w.completed},${w.adherence != null ? `${Math.round(w.adherence * 100)}%` : ""}`,
      );
    }
    csvLines.push(""); // separate the 4-col table from the resumed 2-col summary
  }
  csvLines.push(`Down payments gross,${money(t.downGross)}`);
  csvLines.push(`Recurring collected gross,${money(t.recurringMonthlyGross)}`);
  csvLines.push(`Care credit collected,${money(t.careCreditTotal)}`);
  csvLines.push(`Care credit RevOS take (owed by clinic),${money(t.careCreditRevosShare)}`);
  csvLines.push(`Refunds,${money(t.refunds)}`);
  csvLines.push(`Failed payments (count),${failedCount}`);
  csvLines.push(`Failed payments (amount attempted),${money(failedAmountCents)}`);
  csvLines.push(`Implementor commissions,${money(t.implementorCommission)}`);
  csvLines.push(`Advanced costs,${money(t.advancedCosts)}`);
  csvLines.push(`Payouts to clinics,${money(payoutsTotal)}`);
  csvLines.push(`Balance still owed to clinics,${money(totalBalanceDue)}`);
  csvLines.push("");
  csvLines.push(
    "Clinic,Clinic share collected,Care credit RevOS take,Payouts,Balance due,Down payments,Avg down payment",
  );
  for (const c of clinicBalances) {
    csvLines.push(
      [
        csvEsc(c.name),
        money(c.clinicCollectedShare),
        money(c.careCreditRevosTake),
        money(c.payouts),
        money(c.balanceDue),
        String(c.downCount),
        c.avgDownPaymentCents != null ? money(c.avgDownPaymentCents) : "",
      ].join(","),
    );
  }
  const csv = csvLines.join("\n");
  const csvFilename = `revos-report-${preset}-${new Date().toISOString().slice(0, 10)}.csv`;

  const summary: {
    label: string;
    value: string;
    sub?: string;
    accent?: boolean;
    alert?: boolean;
  }[] = [
    { label: "RevOS share", value: formatMoneyCents(revosShareTotal), accent: true },
    { label: "Clinic share", value: formatMoneyCents(clinicProfit) },
    {
      label: "RevOS net",
      value: formatMoneyCents(revosNet),
      sub: "after fees, commissions & costs",
    },
    {
      label: "Active patients",
      value: activePatientCount.toLocaleString(),
      sub: `${activeBillingCount} currently billing`,
    },
    {
      label: "Patients sold / week",
      value: avgSoldPerWeek.toFixed(1),
      sub: `${soldInPeriod} sold in period`,
    },
    {
      label: "Avg time on program",
      value: avgProgramWeeks != null ? `${avgProgramWeeks.toFixed(1)} wks` : "—",
      sub: "patients currently billing",
    },
    {
      label: "Visit adherence",
      value:
        chartAdherence != null ? `${Math.round(chartAdherence * 100)}%` : "—",
      sub: `${chart.completedOfScheduled}/${chart.scheduled} scheduled visits done · ${chartPatientCount} charted (program-to-date)`,
    },
    {
      label: "Down payments",
      value: formatMoneyCents(t.downGross),
      sub: `${t.downCount} payment${t.downCount === 1 ? "" : "s"}`,
    },
    {
      label: "Recurring (collected)",
      value: formatMoneyCents(t.recurringMonthlyGross),
      sub: `${t.recurringCount} recurring charge${t.recurringCount === 1 ? "" : "s"} in period`,
    },
    {
      label: "Care credit",
      value: formatMoneyCents(t.careCreditTotal),
      sub: `${t.careCreditCount} logged · RevOS take ${formatMoneyCents(t.careCreditRevosShare)}`,
    },
    {
      label: "Balance owed to clinics",
      value: formatMoneyCents(totalBalanceDue),
      sub: `after ${formatMoneyCents(payoutsTotal)} paid out`,
    },
    { label: "Refunds", value: formatMoneyCents(t.refunds) },
    { label: "Advanced costs", value: formatMoneyCents(t.advancedCosts) },
    {
      label: "Failed payments",
      value: failedCount.toLocaleString(),
      sub: `${formatMoneyCents(failedAmountCents)} attempted · not in revenue`,
      alert: failedCount > 0,
    },
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
              <div
                className={`mt-1 text-2xl font-semibold ${s.alert ? "text-red-600" : "text-slate-900"}`}
              >
                {s.value}
              </div>
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
              Recurring revenue (collected in period)
            </h3>
            <BreakdownRow label="Recurring collected (gross)" value={t.recurringMonthlyGross} />
            <BreakdownRow label="Base (fee removed)" value={t.recurringMonthlyBase} muted />
            <BreakdownRow label="RevOS share ($/cycle)" value={t.revosRecurringShare} />
            <BreakdownRow label="Clinic share" value={t.clinicRecurringShare} />
            <BreakdownRow label="Processing fees (RevOS revenue)" value={t.recurringProcessingFee} />
            <BreakdownRow label="LunarPay fees (cost)" value={-t.recurringLunarpayCost} negative />
          </div>
        </div>

        {/* Program-chart adherence by week */}
        {chartWeekBreakdown.length > 0 && (
          <div className="card overflow-hidden">
            <div className="px-5 py-3 border-b border-line">
              <h3 className="text-sm font-semibold text-slate-900">
                Program adherence by week
              </h3>
              <p className="text-xs text-slate-500">
                Completed vs scheduled visits across {chartPatientCount} charted
                patient{chartPatientCount === 1 ? "" : "s"}
                {clinicId ? " in this clinic" : ""} · overall{" "}
                {chartAdherence != null
                  ? `${Math.round(chartAdherence * 100)}%`
                  : "—"}
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>Program week</th>
                    <th className="text-right">Scheduled</th>
                    <th className="text-right">Completed</th>
                    <th className="text-right pr-5">Adherence</th>
                  </tr>
                </thead>
                <tbody>
                  {chartWeekBreakdown.map((w) => (
                    <tr key={w.weekNumber}>
                      <td className="font-medium text-slate-900">
                        Week {w.weekNumber}
                      </td>
                      <td className="text-right text-slate-600 tabular-nums">
                        {w.scheduled}
                      </td>
                      <td className="text-right text-slate-600 tabular-nums">
                        {w.completed}
                      </td>
                      <td className="text-right font-medium text-slate-900 tabular-nums pr-5">
                        {w.adherence != null
                          ? `${Math.round(w.adherence * 100)}%`
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

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
                  <th>On program</th>
                  <th>Down payment(s)</th>
                  <th>Monthly sub</th>
                  <th>Scheduled payments</th>
                  <th>Care credit</th>
                  <th>Refunds</th>
                  <th>Notes</th>
                  <th className="text-right">RevOS</th>
                  <th className="text-right">Clinic</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={12} className="text-center text-slate-500 py-8">
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
                      {r.programWeeks == null ? (
                        <span className="text-slate-400">—</span>
                      ) : r.programActive ? (
                        <span className="badge-green text-[10px]">
                          Wk {r.programWeeks}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-500">
                          {r.programWeeks} wk{r.programWeeks === 1 ? "" : "s"}
                          <span className="text-slate-400"> · ended</span>
                        </span>
                      )}
                    </td>
                    <td>
                      {r.downPayments.length === 0 ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <div className="space-y-0.5">
                          {r.downPayments.map((d, i) => (
                            <div key={i} className="text-xs">
                              {formatMoneyCents(d.amount)}
                              <span className="text-slate-400">
                                {" "}
                                · {formatDate(d.date)}
                              </span>
                              {d.kind === "installment" && (
                                <span className="badge-indigo ml-1 text-[10px]">
                                  {d.scheduledFor
                                    ? `scheduled for ${formatDateOnly(d.scheduledFor)}`
                                    : "scheduled"}
                                </span>
                              )}
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
                              {s.pending ? (
                                <span className="badge-yellow ml-1 text-[10px]">
                                  pending
                                  {s.next
                                    ? ` · ${formatDateOnly(s.next.toISOString().slice(0, 10))}`
                                    : ""}
                                </span>
                              ) : (
                                s.next && (
                                  <span className="text-slate-400">
                                    {" "}
                                    · next{" "}
                                    {formatDateOnly(
                                      s.next.toISOString().slice(0, 10),
                                    )}
                                  </span>
                                )
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>
                      {r.scheduled.length === 0 ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <div className="space-y-1">
                          {r.scheduled.map((s, i) => (
                            <div key={i} className="text-xs space-y-0.5">
                              <span
                                className={
                                  s.status === "active"
                                    ? "badge-green"
                                    : s.status === "completed"
                                      ? "badge-indigo"
                                      : "badge-slate"
                                }
                              >
                                {s.status}
                              </span>
                              {s.oneTime && (
                                <span className="badge-indigo ml-1 text-[10px]">
                                  one-time
                                </span>
                              )}
                              {s.payments.length === 0 ? (
                                <div className="text-slate-400">No dates stored</div>
                              ) : (
                                s.payments.map((p, j) => (
                                  <div key={j}>
                                    <span className="font-medium text-slate-800">
                                      {formatDateOnly(p.date)}
                                    </span>
                                    <span className="text-slate-400">
                                      {" "}
                                      · {formatMoneyCents(p.amount)}
                                      {p.status ? ` · ${p.status}` : ""}
                                    </span>
                                  </div>
                                ))
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>
                      {r.careCredits.length === 0 ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <div className="space-y-0.5">
                          {r.careCredits.map((c, i) => (
                            <div key={i} className="text-xs">
                              {formatMoneyCents(c.amount)}
                              <span className="text-slate-400"> · {formatDate(c.date)}</span>
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

        {/* Clinic balances & payouts */}
        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-line flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                Clinic balances &amp; payouts
              </h3>
              <p className="text-xs text-slate-500">
                Balance due = clinic share of collected revenue − RevOS&apos;s
                care-credit share − payouts already made. Total still owed:{" "}
                <span className="font-medium text-slate-700">
                  {formatMoneyCents(totalBalanceDue)}
                </span>
              </p>
            </div>
            <ClinicPayoutForm
              clinics={clinics.map((c) => ({ id: c.id, name: c.name }))}
              defaultClinicId={clinicId || undefined}
            />
          </div>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Clinic</th>
                  <th className="text-right">Clinic share collected</th>
                  <th className="text-right">Avg down payment</th>
                  <th className="text-right">Care credit (RevOS take)</th>
                  <th className="text-right">Payouts</th>
                  <th className="text-right">Balance due</th>
                </tr>
              </thead>
              <tbody>
                {clinicBalances.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center text-slate-500 py-6">
                      No clinic activity in this period.
                    </td>
                  </tr>
                )}
                {clinicBalances.map((c) => (
                  <tr key={c.id}>
                    <td className="font-medium text-slate-900">{c.name}</td>
                    <td className="text-right text-slate-600">
                      {formatMoneyCents(c.clinicCollectedShare)}
                    </td>
                    <td className="text-right text-slate-600">
                      {c.avgDownPaymentCents != null ? (
                        <>
                          {formatMoneyCents(c.avgDownPaymentCents)}
                          <span className="text-slate-400 text-xs">
                            {" "}
                            · {c.downCount}
                          </span>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="text-right text-slate-600">
                      {c.careCreditRevosTake > 0
                        ? `−${formatMoneyCents(c.careCreditRevosTake)}`
                        : "—"}
                    </td>
                    <td className="text-right text-slate-600">
                      {c.payouts > 0 ? `−${formatMoneyCents(c.payouts)}` : "—"}
                    </td>
                    <td className="text-right font-semibold text-slate-900">
                      {formatMoneyCents(c.balanceDue)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {payouts.length > 0 && (
            <div className="border-t border-line">
              <div className="px-5 py-2 text-xs font-medium text-slate-500">
                Payouts in this period
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Clinic</th>
                    <th>Note</th>
                    <th className="text-right">Amount</th>
                    <th className="text-right print-hidden">·</th>
                  </tr>
                </thead>
                <tbody>
                  {payouts.map((p) => (
                    <tr key={p.id}>
                      <td className="text-slate-600">{formatDate(p.paidOn)}</td>
                      <td className="text-slate-600">{p.clinic?.name ?? "—"}</td>
                      <td className="text-slate-600">{p.note || "—"}</td>
                      <td className="text-right font-medium">
                        {formatMoneyCents(p.amountCents)}
                      </td>
                      <td className="text-right print-hidden">
                        <DeletePayoutButton id={p.id} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
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
          separate LunarPay 3.9% + $0.39 (cost). Recurring figures reflect actual
          recurring charges collected in the selected period.
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
