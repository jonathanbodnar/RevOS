import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSuperAdminClinicApi } from "@/lib/api-guard";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { logAudit } from "@/lib/audit";

/**
 * Change the date(s) of the upcoming payments on an installment schedule
 * (including a deferred down payment, which is itself a one-payment schedule).
 *
 * LunarPay has no "edit schedule" endpoint, so we cancel the existing schedule
 * and recreate it with the still-pending payments on their new dates. Payments
 * already collected are left alone (the money is already in).
 */
const Body = z.object({
  payments: z
    .array(
      z.object({
        amount: z.number().int().min(50),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
      }),
    )
    .min(1),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const guard = await requireSuperAdminClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;
  const { id } = await ctx.params;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "Invalid input" },
      { status: 400 },
    );
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  if (parsed.data.payments.some((p) => p.date < todayStr)) {
    return NextResponse.json(
      { error: "Payment dates can't be in the past." },
      { status: 400 },
    );
  }

  const schedule = await prisma.paymentSchedule.findFirst({
    where: { id, clinicId },
    include: { customer: true },
  });
  if (!schedule) {
    return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
  }
  if (schedule.status !== "active") {
    return NextResponse.json(
      { error: "Only active schedules can be rescheduled." },
      { status: 400 },
    );
  }
  if (!schedule.paymentMethodId) {
    return NextResponse.json(
      { error: "Schedule has no payment method." },
      { status: 400 },
    );
  }

  const pm = await prisma.paymentMethod.findUnique({
    where: { id: schedule.paymentMethodId },
  });
  const lpCustomerId =
    pm?.lunarpayCustomerId ?? schedule.customer.lunarpayCustomerId;
  if (!pm || !lpCustomerId) {
    return NextResponse.json(
      { error: "Customer not synced to LunarPay." },
      { status: 400 },
    );
  }

  try {
    // Cancel the old schedule, then recreate with the new dates.
    await lunarpay.cancelSchedule(schedule.lunarpayScheduleId);
    const lp = await lunarpay.createSchedule({
      customerId: lpCustomerId,
      paymentMethodId: pm.lunarpayPaymentMethodId,
      description: schedule.description ?? undefined,
      payments: parsed.data.payments,
    });

    // Preserve settled history in the snapshot: keep the old schedule's
    // already-resolved items (paid/failed) and append the recreated pending
    // items as LunarPay returned them (they carry the new LP item ids the
    // webhook uses for matching). Storing only the request payload would
    // erase per-item history and strip the ids.
    let settled: unknown[] = [];
    try {
      const prev = JSON.parse(schedule.paymentsJson ?? "[]");
      if (Array.isArray(prev)) {
        settled = prev.filter(
          (p: { status?: string }) =>
            p.status === "paid" || p.status === "failed",
        );
      }
    } catch {
      // ignore an unreadable legacy snapshot
    }
    const mergedPayments = [...settled, ...(lp.data.payments ?? [])];

    const updated = await prisma.paymentSchedule.update({
      where: { id: schedule.id },
      data: {
        lunarpayScheduleId: lp.data.id,
        status: lp.data.status,
        paymentsJson: JSON.stringify(mergedPayments),
      },
    });

    await logAudit({
      actorId: session.user.id,
      actorRole: session.user.originalRole,
      clinicId,
      action: "installment_schedule.reschedule",
      targetType: "PaymentSchedule",
      targetId: schedule.id,
      metadata: {
        oldLunarpayScheduleId: schedule.lunarpayScheduleId,
        newLunarpayScheduleId: lp.data.id,
        payments: parsed.data.payments,
      },
    });

    return NextResponse.json({ ok: true, data: { id: updated.id } });
  } catch (e) {
    const status = e instanceof LunarPayError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Failed to reschedule.";
    return NextResponse.json({ error: msg }, { status });
  }
}
