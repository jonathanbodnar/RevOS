import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSuperAdminClinicApi } from "@/lib/api-guard";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";

/**
 * Read an installment schedule's individual payments (amount/date/status) so
 * the admin can see and reschedule the upcoming ones. Pulled live from
 * LunarPay since that's the source of truth for which payments have run.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const guard = await requireSuperAdminClinicApi();
  if ("error" in guard) return guard.error;
  const { clinicId } = guard;
  const { id } = await ctx.params;

  const schedule = await prisma.paymentSchedule.findFirst({
    where: { id, clinicId },
  });
  if (!schedule) {
    return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
  }

  try {
    const lp = await lunarpay.getSchedule(schedule.lunarpayScheduleId);
    const payments = (lp.data.payments ?? []).map((p) => ({
      amount: p.amount,
      date: typeof p.date === "string" ? p.date.slice(0, 10) : p.date,
      status: p.status,
    }));
    return NextResponse.json({
      data: {
        id: schedule.id,
        status: schedule.status,
        payments,
      },
    });
  } catch (e) {
    const status = e instanceof LunarPayError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Failed to load schedule.";
    return NextResponse.json({ error: msg }, { status });
  }
}
