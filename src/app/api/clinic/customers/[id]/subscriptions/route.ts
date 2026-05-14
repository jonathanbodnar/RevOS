import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { logAudit } from "@/lib/audit";
import { parseMoneyInputToCents } from "@/lib/format";

/**
 * Create a subscription via hosted checkout (mode: "subscription").
 *
 * This does everything in one shot:
 * - Customer pays the first charge immediately on the hosted page
 * - LunarPay auto-creates the recurring subscription after the charge succeeds
 * - Payment method is vaulted automatically
 *
 * The webhook (checkout.session.completed) records the subscription, charge,
 * and payment method in our DB once the customer completes the checkout.
 */
const Body = z.object({
  amount: z.string().min(1),
  frequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]),
  description: z.string().optional(),
  trial: z.boolean().optional(),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const guard = await requireClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;
  const { id } = await ctx.params;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const cents = parseMoneyInputToCents(parsed.data.amount);
  if (cents === null || cents < 50) {
    return NextResponse.json({ error: "Amount must be at least $0.50" }, { status: 400 });
  }

  const customer = await prisma.customer.findFirst({
    where: { id, clinicId },
    include: { clinic: true },
  });
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const clinicLabel = customer.clinic?.name ?? "Clinic";
  const description = parsed.data.description
    ? `[${clinicLabel}] ${parsed.data.description}`
    : `[${clinicLabel}] Subscription — ${parsed.data.frequency}`;

  try {
    const lp = await lunarpay.createCheckoutSession({
      amount: cents / 100, // LP checkout API takes dollars, not cents
      description,
      customer_email: customer.email || undefined,
      customer_name:
        [customer.firstName, customer.lastName].filter(Boolean).join(" ") ||
        undefined,
      payment_methods: ["cc", "ach"],
      mode: "subscription",
      recurring: {
        frequency: parsed.data.frequency,
        trial: parsed.data.trial,
      },
      success_url: `${appUrl}/pay/success`,
      cancel_url: `${appUrl}/pay/cancel`,
      metadata: {
        clinicId,
        customerId: customer.id,
        type: "subscription",
      },
      expires_in: 60 * 60 * 24, // 24 hours
    });

    const checkoutSession = await prisma.checkoutSession.create({
      data: {
        clinicId,
        customerId: customer.id,
        lunarpaySessionId: lp.id,
        token: lp.token,
        url: lp.url,
        amountCents: cents,
        description: parsed.data.description ?? `Subscription — ${parsed.data.frequency}`,
        mode: "subscription",
        status: lp.status,
        metadataJson: JSON.stringify({
          clinicId,
          customerId: customer.id,
          frequency: parsed.data.frequency,
        }),
      },
    });

    await logAudit({
      actorId: session.user.id,
      actorRole: session.user.originalRole,
      clinicId,
      action: "subscription.create",
      targetType: "CheckoutSession",
      targetId: checkoutSession.id,
      metadata: { amountCents: cents, frequency: parsed.data.frequency },
    });

    return NextResponse.json({ url: lp.url, id: checkoutSession.id });
  } catch (e) {
    const status = e instanceof LunarPayError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Subscription failed.";
    return NextResponse.json({ error: msg }, { status });
  }
}
