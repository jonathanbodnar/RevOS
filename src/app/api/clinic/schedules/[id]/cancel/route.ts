import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSuperAdminClinicApi } from "@/lib/api-guard";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { logAudit } from "@/lib/audit";

/**
 * Cancel a customer's installment schedule.
 *
 * Same guard as subscription cancel: only super admins (or the impersonating
 * super admin acting as a clinic) can perform this. Clinic admins / team
 * members cannot.
 *
 * This cancels future payments only. Refunding any payments that have
 * already been collected is done from the customer's Transactions tab,
 * where each paid installment shows up as an individual Charge with its
 * own refund button.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const guard = await requireSuperAdminClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;
  const { id } = await ctx.params;

  const schedule = await prisma.paymentSchedule.findFirst({
    where: { id, clinicId },
  });
  if (!schedule) {
    return NextResponse.json(
      { error: "Installment schedule not found" },
      { status: 404 },
    );
  }
  if (schedule.status === "cancelled") {
    return NextResponse.json({ ok: true, alreadyCancelled: true });
  }

  try {
    await lunarpay.cancelSchedule(schedule.lunarpayScheduleId);
    await prisma.paymentSchedule.update({
      where: { id: schedule.id },
      data: { status: "cancelled" },
    });
    await logAudit({
      actorId: session.user.id,
      actorRole: session.user.originalRole,
      clinicId,
      action: "installment_schedule.cancel",
      targetType: "PaymentSchedule",
      targetId: schedule.id,
      metadata: {
        lunarpayScheduleId: schedule.lunarpayScheduleId,
        totalAmountCents: schedule.totalAmountCents,
        paidAmountCents: schedule.paidAmountCents,
      },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const status = e instanceof LunarPayError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Cancel failed.";
    return NextResponse.json({ error: msg }, { status });
  }
}
