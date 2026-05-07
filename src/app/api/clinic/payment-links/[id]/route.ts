import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { logAudit } from "@/lib/audit";

/**
 * Delete a payment link.
 *
 * Payment links are reusable templates — deleting one stops accepting new
 * payments through the URL (the page 404s) but does NOT touch existing
 * charges, subscriptions, or customers that were created through the link.
 * Their `paymentLinkId` is set to null via the FK's `onDelete: SetNull`.
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
    include: {
      _count: { select: { charges: true, subscriptions: true } },
    },
  });
  if (!cs) {
    return NextResponse.json({ error: "Payment link not found" }, { status: 404 });
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
      chargeCount: cs._count.charges,
      subscriptionCount: cs._count.subscriptions,
    },
  });

  return NextResponse.json({ ok: true });
}
