/**
 * Reconcile LunarPay subscription successes into RevOS Charge rows.
 *
 * LunarPay is authoritative. For every subscription we build the complete set
 * of successful cycle dates from successTrxns + lastPaymentOn, match real
 * webhook rows to those cycles, create missing placeholders, and remove stale
 * placeholders. The write cap limits creations, not scanned cycles, so skipped
 * recent rows no longer prevent older missing cycles from being repaired.
 */

import { prisma } from "@/lib/prisma";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";

export const RECON_ID_PREFIX = "recon:sub:";
export const RENEWAL_MARKER = "Subscription renewal";

function shiftUtcMonthsClamped(date: Date, months: number): Date {
  const day = date.getUTCDate();
  const out = new Date(date);
  out.setUTCDate(1);
  out.setUTCMonth(out.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0),
  ).getUTCDate();
  out.setUTCDate(Math.min(day, lastDay));
  return out;
}

function shiftUtcYearsClamped(date: Date, years: number): Date {
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const out = new Date(date);
  out.setUTCDate(1);
  out.setUTCFullYear(out.getUTCFullYear() + years);
  out.setUTCMonth(month);
  const lastDay = new Date(
    Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0),
  ).getUTCDate();
  out.setUTCDate(Math.min(day, lastDay));
  return out;
}

/** Step back from the latest success without month-end rollover drift. */
export function stepBack(date: Date, frequency: string, n: number): Date {
  const out = new Date(date);
  switch (frequency) {
    case "weekly":
      out.setUTCDate(out.getUTCDate() - 7 * n);
      return out;
    case "quarterly":
      return shiftUtcMonthsClamped(out, -3 * n);
    case "yearly":
      return shiftUtcYearsClamped(out, -n);
    default:
      return shiftUtcMonthsClamped(out, -n);
  }
}

export function expectedRecurringCycles(
  lastPaymentOn: Date,
  frequency: string,
  successTrxns: number,
): Date[] {
  const count = Math.max(0, Math.floor(successTrxns));
  return Array.from({ length: count }, (_, index) =>
    stepBack(lastPaymentOn, frequency, index),
  );
}

/** Deterministic id for a reconciled subscription charge. */
export function reconChargeId(
  lunarpaySubscriptionId: number,
  cycle: Date,
): string {
  return `${RECON_ID_PREFIX}${lunarpaySubscriptionId}:${cycle
    .toISOString()
    .slice(0, 10)}`;
}

function sameUtcDay(a: Date, b: Date): boolean {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

export type ReconSubResult = {
  subscriptionId: string;
  lunarpaySubscriptionId: number;
  frequency: string;
  lunarpayStatus: string | null;
  successTrxns: number;
  alreadyRecorded: number;
  cyclesBackfilled: string[];
  cyclesSkippedExisting: string[];
  cyclesRemoved: string[];
  amountCentsPerCycle: number;
  error?: string;
};

export type ReconSummary = {
  dryRun: boolean;
  scanned: number;
  chargesCreated: number;
  chargesDeleted: number;
  subscriptionsAdvanced: number;
  errors: number;
  results: ReconSubResult[];
};

export type ReconcileOptions = {
  dryRun?: boolean;
  subscriptionId?: string;
  /** Maximum new rows per subscription per run. Existing cycles do not consume it. */
  maxPerSub?: number;
};

export async function reconcileRecurringCharges(
  opts: ReconcileOptions = {},
): Promise<ReconSummary> {
  const dryRun = opts.dryRun ?? true;
  const maxPerSub = opts.maxPerSub ?? 120;
  const subs = await prisma.subscription.findMany({
    where: opts.subscriptionId ? { id: opts.subscriptionId } : {},
    orderBy: { createdAt: "asc" },
  });

  const summary: ReconSummary = {
    dryRun,
    scanned: 0,
    chargesCreated: 0,
    chargesDeleted: 0,
    subscriptionsAdvanced: 0,
    errors: 0,
    results: [],
  };
  // A legacy webhook row has no subscription FK. Never let two subscriptions
  // for the same customer claim the same real transaction during one run.
  const claimedRealChargeIds = new Set<string>();

  for (const sub of subs) {
    summary.scanned += 1;
    const result: ReconSubResult = {
      subscriptionId: sub.id,
      lunarpaySubscriptionId: sub.lunarpaySubscriptionId,
      frequency: sub.frequency,
      lunarpayStatus: null,
      successTrxns: 0,
      alreadyRecorded: 0,
      cyclesBackfilled: [],
      cyclesSkippedExisting: [],
      cyclesRemoved: [],
      amountCentsPerCycle: sub.amountCents,
    };

    try {
      const lp = await lunarpay.getSubscription(sub.lunarpaySubscriptionId);
      const data = lp.data;
      const successTrxns = Math.max(
        0,
        Math.floor(Number(data?.successTrxns ?? 0)),
      );
      const parsedLast = data?.lastPaymentOn
        ? new Date(data.lastPaymentOn)
        : null;
      const lastPaymentOn =
        parsedLast && !Number.isNaN(parsedLast.getTime()) ? parsedLast : null;
      const parsedNext = data?.nextPaymentOn
        ? new Date(data.nextPaymentOn)
        : null;
      const lpNext =
        parsedNext && !Number.isNaN(parsedNext.getTime()) ? parsedNext : null;
      const lpAmount = Math.round(Number(data?.amount));
      const amountCents =
        Number.isFinite(lpAmount) && lpAmount > 0 ? lpAmount : sub.amountCents;

      result.lunarpayStatus = data?.status ?? null;
      result.successTrxns = successTrxns;
      result.amountCentsPerCycle = amountCents;

      const reconPrefix = `${RECON_ID_PREFIX}${sub.lunarpaySubscriptionId}:`;
      const candidates = await prisma.charge.findMany({
        where: {
          customerId: sub.customerId,
          status: { in: ["paid", "pending", "refunded"] },
          OR: [
            { lunarpayChargeId: { startsWith: reconPrefix } },
            {
              description: {
                contains: RENEWAL_MARKER,
                mode: "insensitive",
              },
            },
          ],
        },
        select: {
          id: true,
          lunarpayChargeId: true,
          amountCents: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      });

      const cycles = lastPaymentOn
        ? expectedRecurringCycles(lastPaymentOn, sub.frequency, successTrxns)
        : [];
      const expectedIds = new Set(
        cycles.map((cycle) => reconChargeId(sub.lunarpaySubscriptionId, cycle)),
      );

      // Remove placeholders created by the old nextPaymentOn-based algorithm,
      // plus placeholders superseded by a real transaction below.
      if (lastPaymentOn || successTrxns === 0) {
        for (const row of candidates) {
          if (
            row.lunarpayChargeId.startsWith(reconPrefix) &&
            !expectedIds.has(row.lunarpayChargeId)
          ) {
            if (!dryRun) {
              await prisma.charge.delete({ where: { id: row.id } });
            }
            result.cyclesRemoved.push(row.createdAt.toISOString().slice(0, 10));
            summary.chargesDeleted += 1;
          }
        }
      }

      let createdForSub = 0;
      for (const cycle of cycles) {
        const dateLabel = cycle.toISOString().slice(0, 10);
        const placeholderId = reconChargeId(sub.lunarpaySubscriptionId, cycle);
        const placeholder = candidates.find(
          (row) => row.lunarpayChargeId === placeholderId,
        );
        const real = candidates.find(
          (row) =>
            !row.lunarpayChargeId.startsWith(RECON_ID_PREFIX) &&
            !claimedRealChargeIds.has(row.id) &&
            row.amountCents === amountCents &&
            sameUtcDay(row.createdAt, cycle),
        );

        if (real) {
          claimedRealChargeIds.add(real.id);
          result.alreadyRecorded += 1;
          result.cyclesSkippedExisting.push(dateLabel);
          if (placeholder) {
            if (!dryRun) {
              await prisma.charge.delete({ where: { id: placeholder.id } });
            }
            result.cyclesRemoved.push(dateLabel);
            summary.chargesDeleted += 1;
          }
          continue;
        }
        if (placeholder) {
          result.alreadyRecorded += 1;
          continue;
        }
        if (createdForSub >= maxPerSub) continue;

        if (!dryRun) {
          await prisma.charge.create({
            data: {
              clinicId: sub.clinicId,
              customerId: sub.customerId,
              paymentMethodId: sub.paymentMethodId,
              lunarpayChargeId: placeholderId,
              amountCents,
              status: "paid",
              description: `${RENEWAL_MARKER} (reconciled ${dateLabel})`,
              createdAt: cycle,
            },
          });
        }
        createdForSub += 1;
        result.cyclesBackfilled.push(dateLabel);
        summary.chargesCreated += 1;
      }

      const statusChanged = !!data?.status && data.status !== sub.status;
      const nextChanged =
        !!lpNext && lpNext.getTime() !== (sub.nextPaymentOn?.getTime() ?? 0);
      const amountChanged = amountCents !== sub.amountCents;
      if (statusChanged || nextChanged || amountChanged) {
        summary.subscriptionsAdvanced += 1;
        if (!dryRun) {
          const becameCancelled =
            statusChanged && data?.status === "cancelled" && !sub.cancelledAt;
          await prisma.subscription.update({
            where: { id: sub.id },
            data: {
              amountCents,
              nextPaymentOn: lpNext ?? sub.nextPaymentOn,
              status: data?.status ?? sub.status,
              // Noticing a cancel here means no webhook told us — LunarPay
              // ended it on their side. Stamp it so it isn't left blank and
              // mistaken for a deliberate cancellation.
              ...(becameCancelled
                ? { cancelledAt: new Date(), cancelReason: "auto_failed" }
                : {}),
            },
          });
        }
      }
    } catch (error) {
      summary.errors += 1;
      result.error =
        error instanceof LunarPayError
          ? `LunarPay ${error.status}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
    }

    summary.results.push(result);
  }

  return summary;
}
