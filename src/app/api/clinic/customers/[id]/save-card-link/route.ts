import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { logAudit } from "@/lib/audit";

/**
 * Get-or-create the customer's update-card link.
 *
 * Each customer has at most ONE active save-card link at a time — we look
 * up an existing open one and return its URL, otherwise we mint a new one.
 * The link stays valid until either the customer uses it (the public
 * submit flow flips it to "completed") or the clinic regenerates it via
 * DELETE.
 *
 * The customer-facing page at /pay/save-card/[token] loads Fortis Elements
 * using our publishable key and posts the resulting ticket to the public
 * endpoint /api/public/save-card/[token]; the card is vaulted against
 * THIS customer specifically.
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

  // Reuse an existing open link if there is one — keeps the URL stable so
  // it can be re-shared / re-copied without leaking historical tokens.
  const existing = await prisma.checkoutSession.findFirst({
    where: {
      clinicId,
      customerId: customer.id,
      mode: "save_card",
      status: "open",
    },
    orderBy: { createdAt: "desc" },
  });
  if (existing) {
    return NextResponse.json({ url: existing.url });
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

/**
 * Rotate (regenerate) the customer's update-card link.
 *
 * Deletes any existing open save_card sessions for this customer; the
 * caller can then POST again to mint a fresh URL. Useful if the previous
 * URL was shared with the wrong person or the clinic just wants a new
 * token.
 */
export async function DELETE(
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
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  await prisma.checkoutSession.deleteMany({
    where: {
      clinicId,
      customerId: customer.id,
      mode: "save_card",
      status: "open",
    },
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId,
    action: "save_card_link.rotate",
    targetType: "Customer",
    targetId: customer.id,
  });

  return NextResponse.json({ ok: true });
}
