import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { logAudit } from "@/lib/audit";
import { parseMoneyInputToCents } from "@/lib/format";

/**
 * Create a payment link hosted at /pay/[token] on revosportal.com.
 *
 * Anyone with the link enters their email/name + card on the RevOS-hosted page.
 * On submit, we create the customer in this clinic (or match by email),
 * vault the card via Fortis Elements + LunarPay, and either charge or create
 * a subscription depending on the link mode.
 *
 * No LunarPay hosted checkout is involved — RevOS owns the entire UX.
 */
const Body = z.object({
  amount: z.string().min(1),
  mode: z.enum(["payment", "subscription"]),
  frequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]).optional(),
  description: z.string().optional(),
});

export async function POST(req: Request) {
  const guard = await requireClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const { mode, frequency, description } = parsed.data;
  if (mode === "subscription" && !frequency) {
    return NextResponse.json(
      { error: "Frequency is required for subscriptions" },
      { status: 400 },
    );
  }

  const cents = parseMoneyInputToCents(parsed.data.amount);
  if (cents === null || cents < 50) {
    return NextResponse.json(
      { error: "Amount must be at least $0.50" },
      { status: 400 },
    );
  }

  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
  if (!clinic) {
    return NextResponse.json({ error: "Clinic not found" }, { status: 404 });
  }

  const token = randomBytes(24).toString("hex");
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const url = `${appUrl}/pay/${token}`;

  // CheckoutSession.lunarpaySessionId is a unique Int; payment-link sessions
  // are not real LunarPay sessions, so we use a negative sentinel.
  const negId = -Math.floor(Math.random() * 1_000_000_000);

  const checkoutSession = await prisma.checkoutSession.create({
    data: {
      clinicId,
      customerId: null,
      lunarpaySessionId: negId,
      token,
      url,
      amountCents: cents,
      description: description ?? null,
      mode,
      status: "open",
      metadataJson: JSON.stringify({
        clinicId,
        frequency: frequency ?? null,
      }),
    },
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId,
    action: mode === "subscription" ? "subscription.link.create" : "invoice.link.create",
    targetType: "CheckoutSession",
    targetId: checkoutSession.id,
    metadata: { amountCents: cents, mode, frequency },
  });

  return NextResponse.json({ url, id: checkoutSession.id });
}
