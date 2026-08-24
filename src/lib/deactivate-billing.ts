/**
 * Cancelling a patient's recurring billing when they are marked inactive.
 *
 * LunarPay — not RevOS — is the scheduler: subscriptions and installment
 * schedules fire on their clock, and the nightly reconciler mirrors their
 * status back into our DB. Two consequences drive this design:
 *
 *  1. Cancelling locally does nothing. Worse, it un-does itself: the reconciler
 *     writes LunarPay's status back over ours, so a row flipped to "cancelled"
 *     in Postgres returns to "active" on the next run. Cancellation MUST go to
 *     LunarPay.
 *  2. LunarPay has no un-cancel. This is irreversible, so it is never automatic
 *     — the caller counts first, a human confirms, and only then do we cancel.
 *     Reactivating a patient deliberately does NOT resume anything.
 */
import { prisma } from "./prisma";
import { lunarpay } from "./lunarpay";

export type BillingToCancel = {
  subscriptions: { id: string; lunarpaySubscriptionId: number; amountCents: number; nextPaymentOn: Date | null }[];
  schedules: { id: string; lunarpayScheduleId: number; totalAmountCents: number; paidAmountCents: number }[];
};

/** What would be cancelled — for the confirmation prompt. Read-only. */
export async function pendingBillingForCustomer(
  customerId: string,
): Promise<BillingToCancel> {
  const [subscriptions, schedules] = await Promise.all([
    prisma.subscription.findMany({
      where: { customerId, status: "active" },
      select: { id: true, lunarpaySubscriptionId: true, amountCents: true, nextPaymentOn: true },
    }),
    prisma.paymentSchedule.findMany({
      where: { customerId, status: "active" },
      select: { id: true, lunarpayScheduleId: true, totalAmountCents: true, paidAmountCents: true },
    }),
  ]);
  return { subscriptions, schedules };
}

export type CancelOutcome = {
  subscriptionsCancelled: number;
  schedulesCancelled: number;
  errors: string[];
};

/**
 * Cancel every active subscription and schedule for a customer, at LunarPay
 * first and only then locally. Per-item error handling: one failure must not
 * abandon the rest, because a partial cancellation that stops silently is how
 * a patient keeps getting billed.
 */
export async function cancelBillingForCustomer(
  customerId: string,
): Promise<CancelOutcome> {
  const { subscriptions, schedules } = await pendingBillingForCustomer(customerId);
  const errors: string[] = [];
  let subscriptionsCancelled = 0;
  let schedulesCancelled = 0;

  for (const sub of subscriptions) {
    try {
      await lunarpay.cancelSubscription(sub.lunarpaySubscriptionId);
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { status: "cancelled" },
      });
      subscriptionsCancelled++;
    } catch (e) {
      // Leave the local row "active" on failure: it still IS active at
      // LunarPay, and marking it cancelled here would hide a live charge.
      errors.push(
        `subscription ${sub.lunarpaySubscriptionId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  for (const sch of schedules) {
    try {
      await lunarpay.cancelSchedule(sch.lunarpayScheduleId);
      await prisma.paymentSchedule.update({
        where: { id: sch.id },
        data: { status: "cancelled" },
      });
      schedulesCancelled++;
    } catch (e) {
      errors.push(
        `schedule ${sch.lunarpayScheduleId}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return { subscriptionsCancelled, schedulesCancelled, errors };
}
