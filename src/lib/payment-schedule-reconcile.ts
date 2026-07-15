/** Reconcile paid LunarPay schedule items into RevOS Charge rows. */

import { prisma } from "@/lib/prisma";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { recordFailedCharge } from "@/lib/failed-charge";

export const SCHEDULE_RECON_ID_PREFIX = "recon:schedule:";
export const INSTALLMENT_MARKER = "Installment payment";

// A declined installment normally arrives via the payment.failed webhook. This
// reconciler is the safety net for declines LunarPay never delivered (or that
// failed signature verification). To avoid a one-time alert storm over historic
// declines, only failures within this window (days) fire the Zapier webhook;
// older ones are still recorded so reports/dashboards stay accurate.
export const FAILURE_NOTIFY_WINDOW_DAYS = 4;

export function reconScheduleChargeId(
  lunarpayScheduleId: number,
  itemId: number,
): string {
  return `${SCHEDULE_RECON_ID_PREFIX}${lunarpayScheduleId}:${itemId}`;
}

function itemDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const date = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12),
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

function sameUtcDay(a: Date, b: Date): boolean {
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

export type ScheduleReconResult = {
  scheduleId: string;
  lunarpayScheduleId: number;
  lunarpayStatus: string | null;
  paidItems: number;
  alreadyRecorded: number;
  itemsBackfilled: string[];
  itemsRemoved: string[];
  itemsFailed: string[];
  error?: string;
};

export type ScheduleReconSummary = {
  dryRun: boolean;
  scanned: number;
  chargesCreated: number;
  chargesDeleted: number;
  failuresRecorded: number;
  schedulesUpdated: number;
  errors: number;
  results: ScheduleReconResult[];
};

/** True when the item's due date is recent enough to still warrant an alert. */
export function shouldNotifyFailure(
  itemDueDate: Date,
  now: Date = new Date(),
): boolean {
  const ageMs = now.getTime() - itemDueDate.getTime();
  return ageMs <= FAILURE_NOTIFY_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

export async function reconcilePaymentSchedules(
  opts: {
    dryRun?: boolean;
    scheduleId?: string;
    maxPerSchedule?: number;
  } = {},
): Promise<ScheduleReconSummary> {
  const dryRun = opts.dryRun ?? true;
  const maxPerSchedule = opts.maxPerSchedule ?? 120;
  const schedules = await prisma.paymentSchedule.findMany({
    where: opts.scheduleId ? { id: opts.scheduleId } : {},
    orderBy: { createdAt: "asc" },
  });
  const summary: ScheduleReconSummary = {
    dryRun,
    scanned: 0,
    chargesCreated: 0,
    chargesDeleted: 0,
    failuresRecorded: 0,
    schedulesUpdated: 0,
    errors: 0,
    results: [],
  };
  const claimedRealChargeIds = new Set<string>();

  for (const schedule of schedules) {
    summary.scanned += 1;
    const result: ScheduleReconResult = {
      scheduleId: schedule.id,
      lunarpayScheduleId: schedule.lunarpayScheduleId,
      lunarpayStatus: null,
      paidItems: 0,
      alreadyRecorded: 0,
      itemsBackfilled: [],
      itemsRemoved: [],
      itemsFailed: [],
    };

    try {
      const response = await lunarpay.getSchedule(schedule.lunarpayScheduleId);
      const data = response.data;
      const payments = Array.isArray(data.payments) ? data.payments : [];
      const paidItems = payments.filter((item) => item.status === "paid");
      result.lunarpayStatus = data.status ?? null;
      result.paidItems = paidItems.length;

      const reconPrefix = `${SCHEDULE_RECON_ID_PREFIX}${schedule.lunarpayScheduleId}:`;
      const candidates = await prisma.charge.findMany({
        where: {
          customerId: schedule.customerId,
          status: { in: ["paid", "pending", "refunded"] },
          OR: [
            { lunarpayChargeId: { startsWith: reconPrefix } },
            {
              description: {
                contains: INSTALLMENT_MARKER,
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

      const expectedIds = new Set(
        paidItems.map((item) =>
          reconScheduleChargeId(schedule.lunarpayScheduleId, item.id),
        ),
      );
      for (const row of candidates) {
        if (
          row.lunarpayChargeId.startsWith(reconPrefix) &&
          !expectedIds.has(row.lunarpayChargeId)
        ) {
          if (!dryRun) await prisma.charge.delete({ where: { id: row.id } });
          result.itemsRemoved.push(row.lunarpayChargeId);
          summary.chargesDeleted += 1;
        }
      }

      let createdForSchedule = 0;
      for (const item of paidItems) {
        const paidOn = itemDate(item.date);
        if (!paidOn) continue;
        const amountCents = Math.max(0, Math.round(Number(item.amount)));
        if (amountCents <= 0) continue;
        const placeholderId = reconScheduleChargeId(
          schedule.lunarpayScheduleId,
          item.id,
        );
        const placeholder = candidates.find(
          (row) => row.lunarpayChargeId === placeholderId,
        );
        const real = candidates.find(
          (row) =>
            !row.lunarpayChargeId.startsWith(SCHEDULE_RECON_ID_PREFIX) &&
            !claimedRealChargeIds.has(row.id) &&
            row.amountCents === amountCents &&
            sameUtcDay(row.createdAt, paidOn),
        );

        if (real) {
          claimedRealChargeIds.add(real.id);
          result.alreadyRecorded += 1;
          if (placeholder) {
            if (!dryRun) {
              await prisma.charge.delete({ where: { id: placeholder.id } });
            }
            result.itemsRemoved.push(placeholderId);
            summary.chargesDeleted += 1;
          }
          continue;
        }
        if (placeholder) {
          result.alreadyRecorded += 1;
          continue;
        }
        if (createdForSchedule >= maxPerSchedule) continue;

        if (!dryRun) {
          await prisma.charge.create({
            data: {
              clinicId: schedule.clinicId,
              customerId: schedule.customerId,
              paymentMethodId: schedule.paymentMethodId,
              lunarpayChargeId: placeholderId,
              amountCents,
              status: "paid",
              description: `${INSTALLMENT_MARKER} (reconciled ${item.date.slice(0, 10)})`,
              createdAt: paidOn,
            },
          });
        }
        createdForSchedule += 1;
        result.itemsBackfilled.push(String(item.id));
        summary.chargesCreated += 1;
      }

      // Safety net for declines LunarPay never webhooked. recordFailedCharge is
      // idempotent per externalId, so re-runs never double-record or re-alert.
      const failedItems = payments.filter((item) => item.status === "failed");
      for (const item of failedItems) {
        const dueOn = itemDate(item.date);
        if (!dueOn) continue;
        const amountCents = Math.max(0, Math.round(Number(item.amount)));
        result.itemsFailed.push(String(item.id));
        summary.failuresRecorded += 1;
        if (!dryRun) {
          await recordFailedCharge({
            clinicId: schedule.clinicId,
            customerId: schedule.customerId,
            paymentMethodId: schedule.paymentMethodId,
            amountCents,
            reason: "Installment payment declined",
            description: `${INSTALLMENT_MARKER} (scheduled ${item.date.slice(0, 10)})`,
            externalId: `schedule:${schedule.lunarpayScheduleId}:item:${item.id}`,
            notify: shouldNotifyFailure(dueOn),
          });
        }
      }

      const totalAmountCents = Math.max(0, Math.round(Number(data.totalAmount)));
      const paidAmountCents = Math.max(0, Math.round(Number(data.paidAmount)));
      const paymentsJson = JSON.stringify(payments);
      const mirrorChanged =
        data.status !== schedule.status ||
        totalAmountCents !== schedule.totalAmountCents ||
        paidAmountCents !== schedule.paidAmountCents ||
        paymentsJson !== (schedule.paymentsJson ?? "");
      if (mirrorChanged) {
        summary.schedulesUpdated += 1;
        if (!dryRun) {
          await prisma.paymentSchedule.update({
            where: { id: schedule.id },
            data: {
              status: data.status,
              totalAmountCents,
              paidAmountCents,
              paymentsJson,
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
