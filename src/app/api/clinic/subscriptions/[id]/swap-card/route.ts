import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSuperAdminClinicApi } from "@/lib/api-guard";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { logAudit } from "@/lib/audit";

/**
 * Swap the card on an active subscription.
 *
 * LunarPay's PATCH /subscriptions endpoint only supports amount / frequency /
 * nextPaymentOn — it cannot repoint a subscription to a different saved card.
 * So we cancel the existing LunarPay subscription and recreate it on the new
 * payment method, preserving the existing next-payment date so the customer is
 * not charged early or twice:
 *
 *   startOn = nextPaymentOn − 1 cycle   ⇒   new nextPaymentOn = old nextPaymentOn
 *
 * (LunarPay's first cron charge lands at startOn + 1 cycle — the same
 * convention used everywhere else in this codebase.)
 */
const Body = z.object({
  paymentMethodId: z.string().min(1),
});

type Frequency = "weekly" | "monthly" | "quarterly" | "yearly";

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

  const sub = await prisma.subscription.findFirst({
    where: { id, clinicId },
    include: { customer: true },
  });
  if (!sub) {
    return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
  }
  if (sub.status !== "active") {
    return NextResponse.json(
      { error: "Only active subscriptions can have their card swapped." },
      { status: 400 },
    );
  }
  if (!sub.customer?.lunarpayCustomerId) {
    return NextResponse.json(
      { error: "Customer not synced to LunarPay" },
      { status: 400 },
    );
  }
  if (parsed.data.paymentMethodId === sub.paymentMethodId) {
    return NextResponse.json(
      { error: "That card is already on this subscription." },
      { status: 400 },
    );
  }

  const pm = await prisma.paymentMethod.findFirst({
    where: {
      id: parsed.data.paymentMethodId,
      customerId: sub.customerId,
      isActive: true,
    },
  });
  if (!pm) {
    return NextResponse.json({ error: "Payment method not found" }, { status: 404 });
  }

  const frequency = sub.frequency as Frequency;
  // Preserve the existing billing date. If we somehow don't have a next date,
  // start a fresh cycle from today.
  const startOn =
    sub.nextPaymentOn && sub.nextPaymentOn.getTime() > Date.now()
      ? subtractOneFrequencyIso(sub.nextPaymentOn, frequency)
      : todayIso();

  try {
    // 1) Cancel the old LunarPay subscription so it stops charging the old card.
    await lunarpay.cancelSubscription(sub.lunarpaySubscriptionId);

    // 2) Recreate it on the new card, preserving the schedule (no immediate
    //    charge — first cron charge is startOn + 1 cycle).
    const lpSub = await lunarpay.createSubscription({
      customerId: sub.customer.lunarpayCustomerId,
      paymentMethodId: pm.lunarpayPaymentMethodId,
      amount: sub.amountCents,
      frequency,
      startOn,
    });

    const nextPaymentOn = lpSub.data.nextPaymentOn
      ? new Date(lpSub.data.nextPaymentOn)
      : sub.nextPaymentOn ?? new Date(startOn);

    const updated = await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        lunarpaySubscriptionId: lpSub.data.id,
        paymentMethodId: pm.id,
        status: lpSub.data.status,
        startOn: lpSub.data.startOn ? new Date(lpSub.data.startOn) : new Date(startOn),
        nextPaymentOn,
      },
    });

    await logAudit({
      actorId: session.user.id,
      actorRole: session.user.originalRole,
      clinicId,
      action: "subscription.swap_card",
      targetType: "Subscription",
      targetId: sub.id,
      metadata: {
        oldLunarpaySubscriptionId: sub.lunarpaySubscriptionId,
        newLunarpaySubscriptionId: lpSub.data.id,
        oldPaymentMethodId: sub.paymentMethodId,
        newPaymentMethodId: pm.id,
      },
    });

    return NextResponse.json({ data: { id: updated.id } });
  } catch (e) {
    const status = e instanceof LunarPayError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Failed to swap card.";
    return NextResponse.json({ error: msg }, { status });
  }
}

function todayIso(): string {
  const d = new Date();
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0),
  )
    .toISOString()
    .replace(".000Z", "Z");
}

function subtractOneFrequencyIso(date: Date, frequency: Frequency): string {
  const d = new Date(date);
  switch (frequency) {
    case "weekly":
      d.setUTCDate(d.getUTCDate() - 7);
      break;
    case "quarterly":
      d.setUTCMonth(d.getUTCMonth() - 3);
      break;
    case "yearly":
      d.setUTCFullYear(d.getUTCFullYear() - 1);
      break;
    default:
      d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return d.toISOString().replace(".000Z", "Z");
}
