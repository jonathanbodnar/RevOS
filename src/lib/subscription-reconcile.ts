/**
 * Recurring-charge reconciliation.
 *
 * LunarPay's cron drives the real recurring charges; RevOS is supposed to learn
 * about each one via the `payment.succeeded` webhook and mirror it into the
 * `Charge` table. Those deliveries are fire-and-forget and have been getting
 * lost, so recurring charges were missing from the `Charge` table entirely
 * (they never showed in the transactions export, and reports had to project
 * them from the `Subscription` table instead of counting real dollars).
 *
 * This module self-heals that gap using LunarPay's AUTHORITATIVE counters from
 * get-subscription: `successTrxns` (how many recurring charges actually
 * succeeded) and `lastPaymentOn` (the most recent success). We make the number
 * of recorded renewal charges for a subscription's customer EQUAL
 * `successTrxns` — creating only the delta, dated back from `lastPaymentOn`.
 *
 * IMPORTANT: we deliberately do NOT infer cycles from `nextPaymentOn` — that
 * field advances on FAILED attempts too, so counting cycles against it would
 * fabricate charges for declines that never actually collected.
 *
 * Idempotent: each backfilled charge gets a deterministic id
 * `recon:sub:<lunarpaySubscriptionId>:<YYYY-MM-DD>`, and because creation is
 * bounded by `successTrxns - alreadyRecorded`, re-running (daily cron or a
 * manual re-run) never duplicates or overshoots.
 */

import { prisma } from "@/lib/prisma";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";

export const RECON_ID_PREFIX = "recon:sub:";
const RENEWAL_MARKER = "Subscription renewal";

/** Step a date BACK by `n` billing cycles. */
function stepBack(date: Date, frequency: string, n: number): Date {
  const d = new Date(date);
  switch (frequency) {
    case "weekly":
      d.setDate(d.getDate() - 7 * n);
      break;
    case "quarterly":
      d.setMonth(d.getMonth() - 3 * n);
      break;
    case "yearly":
      d.setFullYear(d.getFullYear() - n);
      break;
    default: // monthly
      d.setMonth(d.getMonth() - n);
  }
  return d;
}

/** Deterministic id for a reconciled (backfilled) subscription charge. */
export function reconChargeId(lunarpaySubscriptionId: number, cycle: Date): string {
  return `${RECON_ID_PREFIX}${lunarpaySubscriptionId}:${cycle
    .toISOString()
    .slice(0, 10)}`;
}

function startOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0),
  );
}
function endOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999),
  );
}

export type ReconSubResult = {
  subscriptionId: string;
  lunarpaySubscriptionId: number;
  frequency: string;
  lunarpayStatus: string | null;
  successTrxns: number;
  alreadyRecorded: number;
  cyclesBackfilled: string[]; // ISO dates we created charges for
  cyclesSkippedExisting: string[]; // a real charge already covered the date
  amountCentsPerCycle: number;
  error?: string;
};

export type ReconSummary = {
  dryRun: boolean;
  scanned: number;
  chargesCreated: number;
  subscriptionsAdvanced: number;
  errors: number;
  results: ReconSubResult[];
};

export type ReconcileOptions = {
  /** When true (default), compute the plan but write nothing. */
  dryRun?: boolean;
  /** Limit to a single subscription (by our cuid) — handy for testing. */
  subscriptionId?: string;
  /** Safety cap on how many charges to backfill per subscription. */
  maxPerSub?: number;
};

/**
 * Reconcile recurring charges for every subscription (or one, if scoped).
 * Never throws — per-subscription failures are collected and reporting
 * continues.
 */
export async function reconcileRecurringCharges(
  opts: ReconcileOptions = {},
): Promise<ReconSummary> {
  const dryRun = opts.dryRun ?? true;
  const maxPerSub = opts.maxPerSub ?? 24;

  const subs = await prisma.subscription.findMany({
    where: {
      ...(opts.subscriptionId ? { id: opts.subscriptionId } : {}),
    },
    orderBy: { createdAt: "asc" },
  });

  const summary: ReconSummary = {
    dryRun,
    scanned: 0,
    chargesCreated: 0,
    subscriptionsAdvanced: 0,
    errors: 0,
    results: [],
  };

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
      // Use OUR stored cents (a known unit) for the charge amount to avoid any
      // dollars-vs-cents ambiguity in the LunarPay `amount` field.
      amountCentsPerCycle: sub.amountCents,
    };

    try {
      const lp = await lunarpay.getSubscription(sub.lunarpaySubscriptionId);
      const data = lp.data;
      const successTrxns = Math.max(0, Math.floor(Number(data?.successTrxns ?? 0)));
      const lastPaymentOn = data?.lastPaymentOn ? new Date(data.lastPaymentOn) : null;
      const lpNext = data?.nextPaymentOn ? new Date(data.nextPaymentOn) : null;
      result.lunarpayStatus = data?.status ?? null;
      result.successTrxns = successTrxns;

      // How many renewal charges have we already recorded for this customer?
      // (Webhook/manual rows aren't keyed by subscription, so we match on the
      // customer + the shared "Subscription renewal" description marker.)
      const alreadyRecorded = await prisma.charge.count({
        where: {
          customerId: sub.customerId,
          status: { in: ["paid", "pending", "refunded"] },
          description: { contains: RENEWAL_MARKER, mode: "insensitive" },
        },
      });
      result.alreadyRecorded = alreadyRecorded;

      const toCreate = Math.min(
        maxPerSub,
        Math.max(0, successTrxns - alreadyRecorded),
      );

      if (toCreate > 0 && lastPaymentOn) {
        // Create the missing successes, most recent first, stepping back a
        // cycle each time from lastPaymentOn.
        for (let k = 0; k < toCreate; k++) {
          const cycle = stepBack(lastPaymentOn, sub.frequency, k);
          const id = reconChargeId(sub.lunarpaySubscriptionId, cycle);

          const existingRecon = await prisma.charge.findUnique({
            where: { lunarpayChargeId: id },
            select: { id: true },
          });
          if (existingRecon) continue;

          // A real (webhook/manual) charge already covering this day?
          const realHit = await prisma.charge.findFirst({
            where: {
              customerId: sub.customerId,
              amountCents: sub.amountCents,
              status: { in: ["paid", "pending", "refunded"] },
              createdAt: { gte: startOfUtcDay(cycle), lte: endOfUtcDay(cycle) },
              NOT: { lunarpayChargeId: { startsWith: RECON_ID_PREFIX } },
            },
            select: { id: true },
          });
          if (realHit) {
            result.cyclesSkippedExisting.push(cycle.toISOString().slice(0, 10));
            continue;
          }

          if (!dryRun) {
            await prisma.charge.create({
              data: {
                clinicId: sub.clinicId,
                customerId: sub.customerId,
                paymentMethodId: sub.paymentMethodId,
                lunarpayChargeId: id,
                amountCents: sub.amountCents,
                status: "paid",
                description: `${RENEWAL_MARKER} (reconciled ${cycle
                  .toISOString()
                  .slice(0, 10)})`,
                // Date the charge to the cycle it belongs to so period-scoped
                // reports and the transactions export place it correctly.
                createdAt: cycle,
              },
            });
          }
          result.cyclesBackfilled.push(cycle.toISOString().slice(0, 10));
          summary.chargesCreated += 1;
        }
      }

      // Fast-forward our mirror of the subscription (status + next date) to
      // match LunarPay's authoritative state.
      const statusChanged = data?.status && data.status !== sub.status;
      const nextChanged =
        !!lpNext && lpNext.getTime() !== (sub.nextPaymentOn?.getTime() ?? 0);
      if (statusChanged || nextChanged) {
        summary.subscriptionsAdvanced += 1;
        if (!dryRun) {
          await prisma.subscription.update({
            where: { id: sub.id },
            data: {
              nextPaymentOn: lpNext ?? sub.nextPaymentOn,
              status: data?.status ?? sub.status,
            },
          });
        }
      }
    } catch (e) {
      summary.errors += 1;
      result.error =
        e instanceof LunarPayError
          ? `LunarPay ${e.status}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
    }

    summary.results.push(result);
  }

  return summary;
}
