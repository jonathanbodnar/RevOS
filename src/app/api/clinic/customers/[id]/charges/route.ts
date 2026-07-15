import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { logAudit } from "@/lib/audit";
import { parseMoneyInputToCents } from "@/lib/format";
import { calcFee } from "@/lib/fees";
import { recordFailedCharge } from "@/lib/failed-charge";

const Body = z.object({
  paymentMethodId: z.string().min(1),
  amount: z.string().min(1),
  description: z.string().optional(),
  // Optional future date (YYYY-MM-DD). When set to a future day, the charge is
  // registered as a one-item LunarPay payment schedule instead of running now.
  scheduledDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

function todayDateStr(): string {
  const n = new Date();
  const y = n.getFullYear();
  const m = String(n.getMonth() + 1).padStart(2, "0");
  const d = String(n.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
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
  const clinicLabel = customer.clinic?.name ?? "Clinic";
  const description = parsed.data.description
    ? `[${clinicLabel}] ${parsed.data.description}`
    : `[${clinicLabel}]`;

  const { totalCents } = calcFee(cents);

  // Future-dated one-time payment: register it as a single-item LunarPay
  // payment schedule so LunarPay's cron runs the charge on the chosen day. A
  // date of today (or in the past) falls through to an immediate charge.
  const scheduledDate = parsed.data.scheduledDate ?? null;
  if (scheduledDate && scheduledDate > todayDateStr()) {
    try {
      const lpSchedule = await lunarpay.createSchedule({
        customerId: pm.lunarpayCustomerId ?? customer.lunarpayCustomerId,
        paymentMethodId: pm.lunarpayPaymentMethodId,
        description,
        payments: [{ amount: totalCents, date: scheduledDate }],
      });

      const schedule = await prisma.paymentSchedule.create({
        data: {
          clinicId,
          customerId: customer.id,
          paymentMethodId: pm.id,
          lunarpayScheduleId: lpSchedule.data.id,
          totalAmountCents: Math.round(lpSchedule.data.totalAmount),
          paidAmountCents: Math.round(lpSchedule.data.paidAmount),
          status: lpSchedule.data.status,
          description: parsed.data.description || null,
          paymentsJson: JSON.stringify(lpSchedule.data.payments),
        },
      });

      await logAudit({
        actorId: session.user.id,
        actorRole: session.user.originalRole,
        clinicId,
        action: "charge.schedule",
        targetType: "PaymentSchedule",
        targetId: schedule.id,
        metadata: { baseCents: cents, totalCents, scheduledDate },
      });

      return NextResponse.json(
        { data: { id: schedule.id, scheduled: true } },
        { status: 201 },
      );
    } catch (e) {
      const status = e instanceof LunarPayError ? e.status : 500;
      const msg = e instanceof Error ? e.message : "Could not schedule payment.";
      return NextResponse.json({ error: msg }, { status });
    }
  }

  try {
    const lp = await lunarpay.createCharge({
      customerId: pm.lunarpayCustomerId ?? customer.lunarpayCustomerId,
      paymentMethodId: pm.lunarpayPaymentMethodId,
      amount: totalCents,
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
      metadata: { baseCents: cents, totalCents },
    });

    return NextResponse.json({ data: { id: charge.id } }, { status: 201 });
  } catch (e) {
    const status = e instanceof LunarPayError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Charge failed.";
    await recordFailedCharge({
      clinicId,
      customerId: customer.id,
      paymentMethodId: pm.id,
      amountCents: totalCents,
      reason: msg,
      paymentMethodType: pm.sourceType,
      description: parsed.data.description || null,
    });
    return NextResponse.json({ error: msg }, { status });
  }
}
