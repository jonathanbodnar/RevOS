import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { logAudit } from "@/lib/audit";
import { parseMoneyInputToCents } from "@/lib/format";

/**
 * Create a payment link not tied to any existing customer.
 *
 * LunarPay collects the payer's info on the hosted checkout page.
 * When the checkout completes, the webhook auto-creates (or matches)
 * the customer for this clinic and saves their payment method.
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
    return NextResponse.json({ error: "Frequency is required for subscriptions" }, { status: 400 });
  }

  const cents = parseMoneyInputToCents(parsed.data.amount);
  if (cents === null || cents < 50) {
    return NextResponse.json({ error: "Amount must be at least $0.50" }, { status: 400 });
  }

  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
  if (!clinic) {
    return NextResponse.json({ error: "Clinic not found" }, { status: 404 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const descriptionLabel = description
    ? `[${clinic.name}] ${description}`
    : mode === "subscription"
    ? `[${clinic.name}] Subscription${frequency ? ` — ${frequency}` : ""}`
    : `[${clinic.name}]`;

  try {
    const lpPayload: Parameters<typeof lunarpay.createCheckoutSession>[0] = {
      amount: cents / 100,
      description: descriptionLabel,
      payment_methods: ["cc", "ach"],
      success_url: `${appUrl}/pay/success`,
      cancel_url: `${appUrl}/pay/cancel`,
      metadata: {
        clinicId,
        type: mode === "subscription" ? "subscription" : "payment",
      },
      expires_in: 60 * 60 * 24, // 24 hours
    };

    if (mode === "subscription" && frequency) {
      lpPayload.mode = "subscription";
      lpPayload.recurring = { frequency };
    }

    const lp = await lunarpay.createCheckoutSession(lpPayload);

    const checkoutSession = await prisma.checkoutSession.create({
      data: {
        clinicId,
        customerId: null,
        lunarpaySessionId: lp.id,
        token: lp.token,
        url: lp.url,
        amountCents: cents,
        description: description ?? null,
        mode,
        status: lp.status,
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

    return NextResponse.json({ url: lp.url, id: checkoutSession.id });
  } catch (e) {
    const status = e instanceof LunarPayError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Failed to create payment link.";
    const details = e instanceof LunarPayError ? e.details : undefined;
    console.error("[payment-links] error:", msg, details);
    return NextResponse.json({ error: msg, details }, { status });
  }
}
