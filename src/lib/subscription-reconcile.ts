/**
 * Recurring-charge reconciliation.
 *
 * LunarPay's cron drives the real recurring charges; RevOS is supposed to learn
 * about each one via the `payment.succeeded` webhook and mirror it into the
 * `Charge` table. Those deliveries are fire-and-forget and have been getting
 * lost, so recurring charges are missing from the `Charge` table entirely
 * (they never show in the transactions export, and reports have to project
 * them from the `Subscription` table instead of counting real dollars).
 *
 * This module self-heals that gap. For each subscription we ask LunarPay for
 * its authoritative `nextPaymentOn` (via the existing get-by-id endpoint) and
 * compare it to what we last recorded. Every cycle boundary LunarPay has
 * advanced PAST — but that we have no charge for — represents a renewal that
 * succeeded while our webhook was asleep. We materialize a `Charge` row for
 * each such cycle, dated to the cycle it belongs to, and fast-forward our
 * subscription's `nextPaymentOn`/`status` to match LunarPay.
 *
 * Idempotent: each backfilled charge gets a deterministic id
 * `recon:sub:<lunarpaySubscriptionId>:<YYYY-MM-DD>`, so re-running (daily cron,
 * or a manual re-run) never duplicates. We also skip a cycle if a real charge
 * for that customer/amount already lives on that day, so we don't double-count
 * a webhook that did land.
 */

import { prisma } from "@/lib/prisma";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";

export const RECON_ID_PREFIX = "recon:sub:";

/** Advance a date by one billing cycle. Mirrors the webhook's stepper. */
function addCycle(date: Date, frequency: string): Date {
  const d = new Date(date);
  switch (frequency) {
    case "weekly":
      d.setDate(d.getDate() + 7);
      break;
    case "quarterly":
      d.setMonth(d.getMonth() + 3);
      break;
    case "yearly":
      d.setFullYear(d.getFullYear() + 1);
      break;
    default: // monthly
      d.setMonth(d.getMonth() + 1);
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
  ourNextPaymentOn: string | null;
  lunarpayNextPaymentOn: string | null;
  lunarpayStatus: string | null;
  cyclesBackfilled: string[]; // ISO dates we created charges for
  cyclesSkippedExisting: string[]; // real charge already covered the cycle
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
  /** Cap on how many cycles to backfill per subscription (guards runaway loops). */
  maxCyclesPerSub?: number;
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
  const maxCycles = opts.maxCyclesPerSub ?? 24;
  const now = new Date();

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
      ourNextPaymentOn: sub.nextPaymentOn?.toISOString() ?? null,
      lunarpayNextPaymentOn: null,
      lunarpayStatus: null,
      cyclesBackfilled: [],
      cyclesSkippedExisting: [],
      // Use OUR stored cents (a known unit) for the charge amount to avoid any
      // dollars-vs-cents ambiguity in the LunarPay `amount` field.
      amountCentsPerCycle: sub.amountCents,
    };

    try {
      const lp = await lunarpay.getSubscription(sub.lunarpaySubscriptionId);
      const data = lp.data;
      const lpNext = data?.nextPaymentOn ? new Date(data.nextPaymentOn) : null;
      result.lunarpayNextPaymentOn = lpNext?.toISOString() ?? null;
      result.lunarpayStatus = data?.status ?? null;

      // The first un-recorded expected charge. Fall back to startOn for legacy
      // rows that never had a nextPaymentOn.
      const start = sub.nextPaymentOn ?? sub.startOn ?? null;

      if (start && lpNext && start.getTime() < lpNext.getTime()) {
        let cycle = new Date(start);
        let guard = 0;
        while (
          cycle.getTime() < lpNext.getTime() &&
          cycle.getTime() <= now.getTime() &&
          guard < maxCycles
        ) {
          guard += 1;
          const id = reconChargeId(sub.lunarpaySubscriptionId, cycle);

          // Already backfilled this cycle on a prior run?
          const existingRecon = await prisma.charge.findUnique({
            where: { lunarpayChargeId: id },
            select: { id: true },
          });
          if (existingRecon) {
            cycle = addCycle(cycle, sub.frequency);
            continue;
          }

          // A real (webhook/manual) charge already covering this cycle? Match on
          // same customer + same amount + same calendar day, ignoring failed and
          // other reconciled rows.
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
            cycle = addCycle(cycle, sub.frequency);
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
                description: `Subscription renewal (reconciled ${cycle
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
          cycle = addCycle(cycle, sub.frequency);
        }
      }

      // Fast-forward our mirror of the subscription so the drift is fixed and
      // the projection-based reports stay accurate too.
      if (!dryRun) {
        const advanced =
          (lpNext && lpNext.getTime() !== (sub.nextPaymentOn?.getTime() ?? 0)) ||
          (data?.status && data.status !== sub.status);
        if (advanced) {
          await prisma.subscription.update({
            where: { id: sub.id },
            data: {
              nextPaymentOn: lpNext ?? sub.nextPaymentOn,
              status: data?.status ?? sub.status,
            },
          });
          summary.subscriptionsAdvanced += 1;
        }
      } else if (
        lpNext &&
        lpNext.getTime() !== (sub.nextPaymentOn?.getTime() ?? 0)
      ) {
        summary.subscriptionsAdvanced += 1;
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
