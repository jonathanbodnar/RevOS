import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { logAudit } from "@/lib/audit";

/**
 * Generate a one-shot URL a customer can open to add a payment method to
 * their own record. We reuse the CheckoutSession table for this (with a
 * synthetic lunarpaySessionId = 0 and mode = "save_card") because it's
 * convenient, and scope the token by customer id.
 *
 * The customer-facing page at /pay/save-card/[token] loads Fortis Elements
 * using our publishable key and posts the resulting ticket to the public
 * endpoint /api/public/save-card/[token].
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const guard = await requireClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;
  const { id } = await ctx.params;

  const customer = await prisma.customer.findFirst({
    where: { id, clinicId },
  });
  if (!customer || !customer.lunarpayCustomerId) {
    return NextResponse.json(
      { error: "Customer must be synced to LunarPay first." },
      { status: 400 },
    );
  }

  const token = randomBytes(24).toString("hex");
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const url = `${appUrl}/pay/save-card/${token}`;

  // Store the link using CheckoutSession; lunarpaySessionId must be unique,
  // and we use negative ids to keep it out of the real LunarPay range.
  const negId = -Math.floor(Math.random() * 1_000_000_000);
  const sess = await prisma.checkoutSession.create({
    data: {
      clinicId,
      customerId: customer.id,
      lunarpaySessionId: negId,
      token,
      url,
      amountCents: 0,
      description: "save-card",
      mode: "save_card",
      status: "open",
      metadataJson: JSON.stringify({ clinicId, customerId: customer.id }),
    },
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId,
    action: "save_card_link.create",
    targetType: "CheckoutSession",
    targetId: sess.id,
  });

  return NextResponse.json({ url });
}
