import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSuperAdminClinicApi } from "@/lib/api-guard";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { logAudit } from "@/lib/audit";
import { parseMoneyInputToCents } from "@/lib/format";

const Body = z.object({
  amount: z.string().optional(),
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
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const charge = await prisma.charge.findFirst({
    where: { id, clinicId },
  });
  if (!charge) {
    return NextResponse.json({ error: "Charge not found" }, { status: 404 });
  }

  let cents: number | undefined;
  if (parsed.data.amount) {
    const c = parseMoneyInputToCents(parsed.data.amount);
    if (c === null || c < 1) {
      return NextResponse.json({ error: "Invalid refund amount" }, { status: 400 });
    }
    cents = c;
  }

  try {
    const lp = await lunarpay.refundCharge(charge.lunarpayChargeId, cents);
    const newRefunded = charge.refundedCents + lp.data.refundedAmount;
    const updated = await prisma.charge.update({
      where: { id: charge.id },
      data: {
        refundedCents: newRefunded,
        status:
          newRefunded >= charge.amountCents ? "refunded" : charge.status,
      },
    });
    await logAudit({
      actorId: session.user.id,
      actorRole: session.user.originalRole,
      clinicId,
      action: "charge.refund",
      targetType: "Charge",
      targetId: charge.id,
      metadata: { refundedAmount: lp.data.refundedAmount },
    });
    return NextResponse.json({ data: { id: updated.id } });
  } catch (e) {
    const status = e instanceof LunarPayError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Refund failed.";
    return NextResponse.json({ error: msg }, { status });
  }
}
