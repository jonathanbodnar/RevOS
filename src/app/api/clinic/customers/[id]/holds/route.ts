import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { logAudit } from "@/lib/audit";
import { parseMoneyInputToCents } from "@/lib/format";

/**
 * Place an authorization hold on a customer's card.
 *
 * Unlike a normal charge, capture: false reserves funds without moving money.
 * The hold expires after ~7 days (Fortis auth window). The clinic must then
 * either capture (charge actual amount ≤ hold amount) or void (release funds).
 *
 * CC only — ACH does not support holds.
 */
const Body = z.object({
  amount: z.string().min(1),
  paymentMethodId: z.string().min(1),
  description: z.string().optional(),
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
    return NextResponse.json(
      { error: "Hold amount must be at least $0.50" },
      { status: 400 },
    );
  }

  const customer = await prisma.customer.findFirst({
    where: { id, clinicId },
    include: { clinic: true },
  });
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  const pm = await prisma.paymentMethod.findFirst({
    where: { id: parsed.data.paymentMethodId, customerId: id, isActive: true },
  });
  if (!pm || !pm.lunarpayPaymentMethodId) {
    return NextResponse.json(
      { error: "Payment method not found" },
      { status: 404 },
    );
  }
  if (pm.sourceType !== "cc") {
    return NextResponse.json(
      { error: "Holds require a credit card — ACH is not supported" },
      { status: 400 },
    );
  }
  if (!customer.lunarpayCustomerId) {
    return NextResponse.json(
      { error: "Customer is not synced to LunarPay" },
      { status: 400 },
    );
  }

  try {
    const clinicLabel = customer.clinic?.name ?? "RevOS";
    const desc = parsed.data.description
      ? `[${clinicLabel}] ${parsed.data.description}`
      : `[${clinicLabel}] Hold`;

    const lpCharge = await lunarpay.createCharge({
      customerId: customer.lunarpayCustomerId,
      paymentMethodId: pm.lunarpayPaymentMethodId,
      amount: cents,
      description: desc,
      capture: false,
    });

    const charge = await prisma.charge.create({
      data: {
        clinicId,
        customerId: id,
        paymentMethodId: pm.id,
        lunarpayChargeId: String(lpCharge.data.id),
        fortisTransactionId: lpCharge.data.fortisTransactionId ?? null,
        amountCents: cents,
        status: "authorized",
        paymentMethodType: "cc",
        description: parsed.data.description ?? null,
      },
    });

    await logAudit({
      actorId: session.user.id,
      actorRole: session.user.originalRole,
      clinicId,
      action: "hold.place",
      targetType: "Charge",
      targetId: charge.id,
      metadata: { amountCents: cents, description: parsed.data.description },
    });

    return NextResponse.json({ id: charge.id });
  } catch (e) {
    const status = e instanceof LunarPayError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Hold failed";
    return NextResponse.json({ error: msg }, { status });
  }
}
