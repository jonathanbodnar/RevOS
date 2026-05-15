import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { logAudit } from "@/lib/audit";

/**
 * Void an authorized hold — release the funds without charging.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string; holdId: string }> },
) {
  const guard = await requireClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;
  const { id, holdId } = await ctx.params;

  const charge = await prisma.charge.findFirst({
    where: { id: holdId, customerId: id, clinicId, status: "authorized" },
  });
  if (!charge) {
    return NextResponse.json(
      { error: "Hold not found or already captured/voided" },
      { status: 404 },
    );
  }

  try {
    await lunarpay.voidCharge(charge.lunarpayChargeId);

    const updated = await prisma.charge.update({
      where: { id: holdId },
      data: { status: "voided" },
    });

    await logAudit({
      actorId: session.user.id,
      actorRole: session.user.originalRole,
      clinicId,
      action: "hold.void",
      targetType: "Charge",
      targetId: holdId,
      metadata: { amountCents: charge.amountCents },
    });

    return NextResponse.json({ id: updated.id, status: updated.status });
  } catch (e) {
    const status = e instanceof LunarPayError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Void failed";
    return NextResponse.json({ error: msg }, { status });
  }
}
