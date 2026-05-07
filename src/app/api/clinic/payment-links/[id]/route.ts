import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { logAudit } from "@/lib/audit";

/**
 * Delete a payment link.
 *
 * Only links that have NOT been completed are deletable — once a charge has
 * been captured / a subscription created, the underlying records (Charge,
 * Subscription, PaymentMethod) are tied to a real customer and we should
 * not silently drop the trail. The CheckoutSession row is removed entirely;
 * the token URL becomes 404 immediately.
 */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const guard = await requireClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;
  const { id } = await ctx.params;

  const cs = await prisma.checkoutSession.findFirst({
    where: { id, clinicId },
  });
  if (!cs) {
    return NextResponse.json({ error: "Payment link not found" }, { status: 404 });
  }

  if (cs.status === "completed") {
    return NextResponse.json(
      { error: "Cannot delete a completed payment link." },
      { status: 400 },
    );
  }

  await prisma.checkoutSession.delete({ where: { id: cs.id } });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId,
    action: "payment_link.delete",
    targetType: "CheckoutSession",
    targetId: cs.id,
    metadata: {
      mode: cs.mode,
      amountCents: cs.amountCents,
      previousStatus: cs.status,
    },
  });

  return NextResponse.json({ ok: true });
}
