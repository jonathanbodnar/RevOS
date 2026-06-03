/**
 * Reporting math for the super-admin reporting center.
 *
 * Money model (all integers, in cents):
 *  - Every transaction has the customer-facing processing fee (3.9% + $0.39)
 *    baked into its stored amount. `reverseFee` recovers the base price and the
 *    fee portion RevOS collected.
 *  - LunarPay charges RevOS a SECOND 3.9% + $0.39 on the gross — that's a cost.
 *  - Down payments (one-time / setup / installment / manual charges) are split
 *    between RevOS and the clinic per the clinic's configured share %.
 *  - Each down payment with an assigned implementor pays a flat commission.
 *  - Recurring subscription payments give RevOS a flat per-cycle share ($75).
 *  - Advanced costs (supplements, booklets) are subtracted from RevOS profit.
 *
 * NOTE: recurring subscription cron charges are not stored as individual Charge
 * rows, so recurring revenue is projected from active subscriptions, not actual
 * historical charges. The UI labels these figures as projected.
 */

import { FEE_PERCENT, FEE_FLAT_CENTS, calcFee } from "./fees";

export type PeriodPreset = "mtd" | "last_month" | "ytd" | "range" | "all";

export type ResolvedPeriod = {
  preset: PeriodPreset;
  start: Date | null;
  end: Date | null;
  label: string;
};

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
}
function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export function resolvePeriod(
  preset: PeriodPreset,
  fromStr?: string | null,
  toStr?: string | null,
  now: Date = new Date(),
): ResolvedPeriod {
  switch (preset) {
    case "mtd": {
      const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      return { preset, start, end: now, label: `Month to date · ${MONTHS[now.getMonth()]} ${now.getFullYear()}` };
    }
    case "last_month": {
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
      const end = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      return { preset, start, end, label: `${MONTHS[start.getMonth()]} ${start.getFullYear()}` };
    }
    case "ytd": {
      const start = new Date(now.getFullYear(), 0, 1, 0, 0, 0, 0);
      return { preset, start, end: now, label: `Year to date · ${now.getFullYear()}` };
    }
    case "range": {
      const start = fromStr ? startOfDay(new Date(fromStr)) : null;
      const end = toStr ? endOfDay(new Date(toStr)) : null;
      const fmt = (d: Date | null) => (d ? d.toLocaleDateString("en-US") : "…");
      return { preset, start, end, label: `${fmt(start)} – ${fmt(end)}` };
    }
    default:
      return { preset: "all", start: null, end: null, label: "All time" };
  }
}

/** Recover the base price and processing-fee portion from a fee-included total. */
export function reverseFee(totalCents: number): { baseCents: number; feeCents: number } {
  if (totalCents <= FEE_FLAT_CENTS) {
    return { baseCents: 0, feeCents: totalCents };
  }
  let base = Math.round((totalCents - FEE_FLAT_CENTS) / (1 + FEE_PERCENT));
  if (base < 0) base = 0;
  // Correct any rounding drift so reverseFee(calcFee(x).total) === x.
  for (const cand of [base, base - 1, base + 1, base - 2, base + 2]) {
    if (cand < 0) continue;
    if (calcFee(cand).totalCents === totalCents) {
      base = cand;
      break;
    }
  }
  return { baseCents: base, feeCents: totalCents - base };
}

/** The fee LunarPay charges RevOS on a gross transaction (a RevOS cost). */
export function lunarpayCostCents(grossCents: number): number {
  return Math.round(grossCents * FEE_PERCENT) + FEE_FLAT_CENTS;
}

export type ClinicShareConfig = {
  revosDownPaymentSharePct: number;
  implementorFeeCents: number;
  revosRecurringShareCents: number;
};

export type DownPaymentEconomics = {
  grossCents: number; // fee-included amount charged
  baseCents: number; // down payment price (fee removed)
  processingFeeCents: number; // fee RevOS collected (revenue)
  lunarpayCostCents: number; // fee LunarPay charged RevOS (cost)
  revosShareCents: number; // RevOS cut of the base
  clinicShareCents: number; // clinic cut of the base
  implementorCommissionCents: number; // paid to implementor (cost), 0 if none
  revosProfitCents: number;
  clinicProfitCents: number;
};

export function downPaymentEconomics(
  grossCents: number,
  cfg: ClinicShareConfig,
  implementorCommissionCents: number | null,
): DownPaymentEconomics {
  const { baseCents, feeCents } = reverseFee(grossCents);
  const lpCost = lunarpayCostCents(grossCents);
  const pct = Math.min(100, Math.max(0, cfg.revosDownPaymentSharePct));
  const revosShare = Math.round((baseCents * pct) / 100);
  const clinicShare = baseCents - revosShare;
  const commission = implementorCommissionCents ?? 0;
  return {
    grossCents,
    baseCents,
    processingFeeCents: feeCents,
    lunarpayCostCents: lpCost,
    revosShareCents: revosShare,
    clinicShareCents: clinicShare,
    implementorCommissionCents: commission,
    revosProfitCents: revosShare + feeCents - lpCost - commission,
    clinicProfitCents: clinicShare,
  };
}

export type RecurringEconomics = {
  grossCents: number;
  baseCents: number;
  processingFeeCents: number;
  lunarpayCostCents: number;
  revosShareCents: number;
  clinicShareCents: number;
  revosProfitCents: number;
  clinicProfitCents: number;
};

export function recurringEconomics(
  grossCents: number,
  cfg: ClinicShareConfig,
): RecurringEconomics {
  const { baseCents, feeCents } = reverseFee(grossCents);
  const lpCost = lunarpayCostCents(grossCents);
  const revosShare = Math.min(baseCents, cfg.revosRecurringShareCents);
  const clinicShare = baseCents - revosShare;
  return {
    grossCents,
    baseCents,
    processingFeeCents: feeCents,
    lunarpayCostCents: lpCost,
    revosShareCents: revosShare,
    clinicShareCents: clinicShare,
    revosProfitCents: revosShare + feeCents - lpCost,
    clinicProfitCents: clinicShare,
  };
}

/** Monthly-equivalent multiplier for normalizing recurring revenue. */
export function monthlyFactor(frequency: string): number {
  switch (frequency) {
    case "weekly":
      return 52 / 12;
    case "quarterly":
      return 1 / 3;
    case "yearly":
      return 1 / 12;
    default:
      return 1; // monthly
  }
}
