import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { logAudit } from "@/lib/audit";
import { parseMoneyInputToCents } from "@/lib/format";

const Body = z.object({
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
    : `[${clinicLabel}]`;

  try {
    const lp = await lunarpay.createCheckoutSession({
      amount: cents / 100,
      description,
      customer_email: customer.email || undefined,
      customer_name:
        [customer.firstName, customer.lastName].filter(Boolean).join(" ") ||
        undefined,
      payment_methods: ["cc", "ach"],
      mode: "payment",
      success_url: `${appUrl}/pay/success`,
      cancel_url: `${appUrl}/pay/cancel`,
      metadata: {
        clinicId,
        customerId: customer.id,
      },
      expires_in: 60 * 60 * 24, // 24 hours
    });

    const session_ = await prisma.checkoutSession.create({
      data: {
        clinicId,
        customerId: customer.id,
        lunarpaySessionId: lp.id,
        token: lp.token,
        url: lp.url,
        amountCents: cents,
        description: parsed.data.description || null,
        mode: "payment",
        status: lp.status,
        metadataJson: JSON.stringify({ clinicId, customerId: customer.id }),
      },
    });

    await logAudit({
      actorId: session.user.id,
      actorRole: session.user.originalRole,
      clinicId,
      action: "invoice.create",
      targetType: "CheckoutSession",
      targetId: session_.id,
      metadata: { amountCents: cents },
    });

    return NextResponse.json({ url: lp.url, id: session_.id });
  } catch (e) {
    const status = e instanceof LunarPayError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Failed to create invoice.";
    const details = e instanceof LunarPayError ? e.details : undefined;
    console.error("[invoices] LunarPay error:", msg, details);
    return NextResponse.json({ error: msg, details }, { status });
  }
}
