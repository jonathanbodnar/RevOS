import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { logAudit } from "@/lib/audit";
import { parseMoneyInputToCents } from "@/lib/format";
import { calcFee } from "@/lib/fees";

/**
 * Start a subscription for a customer.
 *
 * Two modes:
 *
 * A) paymentMethodId provided — charge a card already on file. We charge the
 *    first cycle immediately (fee included) and create the recurring
 *    subscription on that saved card with startOn = today, so LunarPay's cron
 *    handles every cycle after this one. Records the charge + subscription in
 *    our DB directly (no customer interaction needed).
 *
 * B) no paymentMethodId — generate a hosted checkout link (mode:
 *    "subscription"). The customer pays the first charge on the hosted page,
 *    LunarPay vaults the card and auto-creates the subscription, and the
 *    checkout.session.completed webhook records everything in our DB.
 */
const Body = z.object({
  amount: z.string().min(1),
  frequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]),
  description: z.string().optional(),
  trial: z.boolean().optional(),
  // When set, charge a saved card directly instead of generating a link.
  paymentMethodId: z.string().optional(),
});

type Frequency = "weekly" | "monthly" | "quarterly" | "yearly";

function todayIso(): string {
  const d = new Date();
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0),
  )
    .toISOString()
    .replace(".000Z", "Z");
}

function addOneFrequency(d: Date, frequency: Frequency): Date {
  const out = new Date(d);
  switch (frequency) {
    case "weekly":
      out.setUTCDate(out.getUTCDate() + 7);
      break;
    case "quarterly":
      out.setUTCMonth(out.getUTCMonth() + 3);
      break;
    case "yearly":
      out.setUTCFullYear(out.getUTCFullYear() + 1);
      break;
    default:
      out.setUTCMonth(out.getUTCMonth() + 1);
  }
  return out;
}

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

  // ─── MODE A: charge a saved card directly ────────────────────────────────
  if (parsed.data.paymentMethodId) {
    if (!customer.lunarpayCustomerId) {
      return NextResponse.json(
        { error: "Customer not synced to LunarPay" },
        { status: 400 },
      );
    }
    const pm = await prisma.paymentMethod.findFirst({
      where: {
        id: parsed.data.paymentMethodId,
        customerId: customer.id,
        isActive: true,
      },
    });
    if (!pm) {
      return NextResponse.json(
        { error: "Payment method not found" },
        { status: 404 },
      );
    }

    const { totalCents } = calcFee(cents);
    const frequency = parsed.data.frequency;
    const isTrial = !!parsed.data.trial;
    const startOn = todayIso();

    try {
      // First cycle charged immediately (skipped for trials), then the
      // recurring subscription starts today so LunarPay handles every cycle
      // after this one.
      if (!isTrial) {
        const lpCharge = await lunarpay.createCharge({
          customerId: customer.lunarpayCustomerId,
          paymentMethodId: pm.lunarpayPaymentMethodId,
          amount: totalCents,
          description,
        });
        await prisma.charge.create({
          data: {
            clinicId,
            customerId: customer.id,
            paymentMethodId: pm.id,
            lunarpayChargeId: String(lpCharge.data.id),
            fortisTransactionId: lpCharge.data.fortisTransactionId ?? null,
            amountCents: lpCharge.data.amount,
            status: lpCharge.data.status,
            paymentMethodType: lpCharge.data.paymentMethod,
            description: parsed.data.description || null,
          },
        });
      }

      const lpSub = await lunarpay.createSubscription({
        customerId: customer.lunarpayCustomerId,
        paymentMethodId: pm.lunarpayPaymentMethodId,
        amount: totalCents,
        frequency,
        startOn,
        trial: isTrial,
      });

      const nextPaymentOn = lpSub.data.nextPaymentOn
        ? new Date(lpSub.data.nextPaymentOn)
        : addOneFrequency(new Date(startOn), frequency);

      const subscription = await prisma.subscription.create({
        data: {
          clinicId,
          customerId: customer.id,
          paymentMethodId: pm.id,
          lunarpaySubscriptionId: lpSub.data.id,
          amountCents: totalCents,
          frequency,
          status: lpSub.data.status,
          startOn: lpSub.data.startOn ? new Date(lpSub.data.startOn) : new Date(startOn),
          nextPaymentOn,
          description: parsed.data.description ?? null,
        },
      });

      await logAudit({
        actorId: session.user.id,
        actorRole: session.user.originalRole,
        clinicId,
        action: "subscription.create.saved_card",
        targetType: "Subscription",
        targetId: subscription.id,
        metadata: {
          baseCents: cents,
          totalCents,
          frequency,
          paymentMethodId: pm.id,
          trial: isTrial,
        },
      });

      return NextResponse.json(
        { data: { id: subscription.id } },
        { status: 201 },
      );
    } catch (e) {
      const status = e instanceof LunarPayError ? e.status : 500;
      const msg = e instanceof Error ? e.message : "Subscription failed.";
      return NextResponse.json({ error: msg }, { status });
    }
  }

  // ─── MODE B: generate a hosted checkout link ─────────────────────────────
  try {
    const { feeCents, totalCents } = calcFee(cents);
    const lp = await lunarpay.createCheckoutSession({
      amount: totalCents / 100, // LP checkout API takes dollars; fee included
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
      expires_in: 60 * 60 * 24,
    });

    const checkoutSession = await prisma.checkoutSession.create({
      data: {
        clinicId,
        customerId: customer.id,
        lunarpaySessionId: lp.id,
        token: lp.token,
        url: lp.url,
        amountCents: totalCents,
        description: parsed.data.description ?? `Subscription — ${parsed.data.frequency}`,
        mode: "subscription",
        status: lp.status,
        metadataJson: JSON.stringify({
          clinicId,
          customerId: customer.id,
          frequency: parsed.data.frequency,
          baseCents: cents,
          feeCents,
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
      metadata: { baseCents: cents, totalCents, frequency: parsed.data.frequency },
    });

    return NextResponse.json({ url: lp.url, id: checkoutSession.id });
  } catch (e) {
    const status = e instanceof LunarPayError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Subscription failed.";
    return NextResponse.json({ error: msg }, { status });
  }
}
