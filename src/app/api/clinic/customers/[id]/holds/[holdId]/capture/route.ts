import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { logAudit } from "@/lib/audit";
import { parseMoneyInputToCents } from "@/lib/format";
import { recordFailedCharge } from "@/lib/failed-charge";

/**
 * Capture an authorized hold — move the money.
 * Pass amount to partial-capture (≤ hold amount); omit to capture the full hold.
 */
const Body = z.object({
  amount: z.string().optional(),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; holdId: string }> },
) {
  const guard = await requireClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;
  const { id, holdId } = await ctx.params;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const charge = await prisma.charge.findFirst({
    where: { id: holdId, customerId: id, clinicId, status: "authorized" },
  });
  if (!charge) {
    return NextResponse.json(
      { error: "Hold not found or already captured/voided" },
      { status: 404 },
    );
  }

  let captureCents: number | undefined;
  if (parsed.data.amount) {
    const c = parseMoneyInputToCents(parsed.data.amount);
    if (c === null || c < 1) {
      return NextResponse.json({ error: "Invalid capture amount" }, { status: 400 });
    }
    if (c > charge.amountCents) {
      return NextResponse.json(
        { error: "Capture amount cannot exceed the hold amount" },
        { status: 400 },
      );
    }
    captureCents = c;
  }

  try {
    await lunarpay.captureCharge(charge.lunarpayChargeId, captureCents);

    const updated = await prisma.charge.update({
      where: { id: holdId },
      data: {
        status: "paid",
        amountCents: captureCents ?? charge.amountCents,
      },
    });

    await logAudit({
      actorId: session.user.id,
      actorRole: session.user.originalRole,
      clinicId,
      action: "hold.capture",
      targetType: "Charge",
      targetId: holdId,
      metadata: { captureCents: captureCents ?? charge.amountCents },
    });

    return NextResponse.json({ id: updated.id, status: updated.status });
  } catch (e) {
    const status = e instanceof LunarPayError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Capture failed";
    // Capturing a hold moves real money — a decline here is a denied payment,
    // so record it and fire the failed-payment webhook.
    await recordFailedCharge({
      clinicId,
      customerId: id,
      paymentMethodId: charge.paymentMethodId,
      amountCents: captureCents ?? charge.amountCents,
      reason: msg,
      paymentMethodType: charge.paymentMethodType,
      description: charge.description
        ? `Hold capture — ${charge.description}`
        : "Hold capture",
    });
    return NextResponse.json({ error: msg }, { status });
  }
}
