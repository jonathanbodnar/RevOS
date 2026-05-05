import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { logAudit } from "@/lib/audit";
import { parseMoneyInputToCents } from "@/lib/format";

const Body = z.object({
  paymentMethodId: z.string().min(1),
  amount: z.string().min(1),
  frequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]),
  startOn: z.string().optional(),
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
  });
  if (!customer || !customer.lunarpayCustomerId) {
    return NextResponse.json({ error: "Customer not synced" }, { status: 400 });
  }
  const pm = await prisma.paymentMethod.findFirst({
    where: {
      id: parsed.data.paymentMethodId,
      customerId: customer.id,
      isActive: true,
    },
  });
  if (!pm) {
    return NextResponse.json({ error: "Payment method not found" }, { status: 404 });
  }

  try {
    const startOnIso = parsed.data.startOn
      ? new Date(parsed.data.startOn).toISOString()
      : undefined;
    const lp = await lunarpay.createSubscription({
      customerId: customer.lunarpayCustomerId,
      paymentMethodId: pm.lunarpayPaymentMethodId,
      amount: cents,
      frequency: parsed.data.frequency,
      startOn: startOnIso,
    });
    const sub = await prisma.subscription.create({
      data: {
        clinicId,
        customerId: customer.id,
        paymentMethodId: pm.id,
        lunarpaySubscriptionId: lp.data.id,
        amountCents: lp.data.amount,
        frequency: lp.data.frequency,
        status: lp.data.status,
        startOn: lp.data.startOn ? new Date(lp.data.startOn) : null,
        nextPaymentOn: lp.data.nextPaymentOn
          ? new Date(lp.data.nextPaymentOn)
          : null,
      },
    });
    await logAudit({
      actorId: session.user.id,
      actorRole: session.user.originalRole,
      clinicId,
      action: "subscription.create",
      targetType: "Subscription",
      targetId: sub.id,
    });
    return NextResponse.json({ data: { id: sub.id } }, { status: 201 });
  } catch (e) {
    const status = e instanceof LunarPayError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Subscription failed.";
    return NextResponse.json({ error: msg }, { status });
  }
}
