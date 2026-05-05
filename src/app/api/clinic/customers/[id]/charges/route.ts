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
      { error: "Amount must be at least $0.50" },
      { status: 400 },
    );
  }

  const customer = await prisma.customer.findFirst({
    where: { id, clinicId },
    include: { clinic: true },
  });
  if (!customer || !customer.lunarpayCustomerId) {
    return NextResponse.json(
      { error: "Customer not synced to LunarPay" },
      { status: 400 },
    );
  }
  const pm = await prisma.paymentMethod.findFirst({
    where: { id: parsed.data.paymentMethodId, customerId: customer.id, isActive: true },
  });
  if (!pm) {
    return NextResponse.json({ error: "Payment method not found" }, { status: 404 });
  }

  // Tag charge with clinic context in the description so it's auditable in
  // the shared LunarPay merchant dashboard.
  const description = parsed.data.description
    ? `[${customer.clinic.name}] ${parsed.data.description}`
    : `[${customer.clinic.name}]`;

  try {
    const lp = await lunarpay.createCharge({
      customerId: customer.lunarpayCustomerId,
      paymentMethodId: pm.lunarpayPaymentMethodId,
      amount: cents,
      description,
    });

    const charge = await prisma.charge.create({
      data: {
        clinicId,
        customerId: customer.id,
        paymentMethodId: pm.id,
        lunarpayChargeId: String(lp.data.id),
        fortisTransactionId: lp.data.fortisTransactionId ?? null,
        amountCents: lp.data.amount,
        status: lp.data.status,
        paymentMethodType: lp.data.paymentMethod,
        description: parsed.data.description || null,
      },
    });

    await logAudit({
      actorId: session.user.id,
      actorRole: session.user.originalRole,
      clinicId,
      action: "charge.create",
      targetType: "Charge",
      targetId: charge.id,
      metadata: { amountCents: cents },
    });

    return NextResponse.json({ data: { id: charge.id } }, { status: 201 });
  } catch (e) {
    const status = e instanceof LunarPayError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Charge failed.";
    return NextResponse.json({ error: msg }, { status });
  }
}
