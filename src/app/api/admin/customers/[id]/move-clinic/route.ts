import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { requireStringParams } from "@/lib/route-params";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * Move a patient to a different clinic (super admin only).
 *
 * The customer AND every billing artifact that carries its own clinicId
 * (charges, subscriptions, schedules, checkout sessions, care credits,
 * advanced costs, InBody tests) move together, so reporting and clinic
 * balances attribute the patient's full history to the destination clinic —
 * no split-brain rows left pointing at the old clinic.
 */
const Body = z.object({
  clinicId: z.string().min(1),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (session?.user?.originalRole !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const params = await requireStringParams(ctx.params, ["id"] as const);
  if (!params.ok) return params.response;
  const { id } = params.value;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const targetClinicId = parsed.data.clinicId;

  const [customer, targetClinic] = await Promise.all([
    prisma.customer.findUnique({
      where: { id },
      select: { id: true, clinicId: true, firstName: true, lastName: true, email: true },
    }),
    prisma.clinic.findUnique({
      where: { id: targetClinicId },
      select: { id: true, name: true, isActive: true },
    }),
  ]);
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }
  if (!targetClinic) {
    return NextResponse.json({ error: "Destination clinic not found" }, { status: 404 });
  }
  if (customer.clinicId === targetClinic.id) {
    return NextResponse.json(
      { error: "Patient is already in that clinic." },
      { status: 400 },
    );
  }
  const fromClinicId = customer.clinicId;

  await prisma.$transaction(async (tx) => {
    await tx.customer.update({
      where: { id: customer.id },
      data: { clinicId: targetClinic.id },
    });
    const where = { customerId: customer.id };
    const data = { clinicId: targetClinic.id };
    await tx.charge.updateMany({ where, data });
    await tx.subscription.updateMany({ where, data });
    await tx.paymentSchedule.updateMany({ where, data });
    await tx.checkoutSession.updateMany({ where, data });
    await tx.careCredit.updateMany({ where, data });
    await tx.advancedCost.updateMany({ where, data });
    await tx.inBodyTest.updateMany({ where, data });
    await tx.chartWeek.updateMany({ where, data });
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId: targetClinic.id,
    action: "customer.move_clinic",
    targetType: "Customer",
    targetId: customer.id,
    metadata: { fromClinicId, toClinicId: targetClinic.id },
  });

  return NextResponse.json({ data: { moved: true, clinicId: targetClinic.id } });
}
