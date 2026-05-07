import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { logAudit } from "@/lib/audit";
import { requireStringParams } from "@/lib/route-params";

const Body = z.object({
  ticketId: z.string().min(1),
  paymentMethod: z.enum(["cc", "ach"]).optional(),
  nameHolder: z.string().optional(),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const params = await requireStringParams(ctx.params, ["token"] as const);
  if (!params.ok) return params.response;
  const { token } = params.value;
  const sess = await prisma.checkoutSession.findUnique({
    where: { token },
    include: { customer: true },
  });
  if (!sess || sess.mode !== "save_card" || sess.status !== "open") {
    return NextResponse.json({ error: "Link expired or invalid" }, { status: 404 });
  }
  const customer = sess.customer;
  if (!customer || !customer.lunarpayCustomerId) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  try {
    // Cards added via the update-card link always become the new default —
    // the customer is explicitly replacing their billing card.
    const lp = await lunarpay.savePaymentMethod(customer.lunarpayCustomerId, {
      ticketId: parsed.data.ticketId,
      paymentMethod: parsed.data.paymentMethod,
      nameHolder: parsed.data.nameHolder,
      setDefault: true,
    });

    // Clear the current default before setting the new one.
    await prisma.paymentMethod.updateMany({
      where: { customerId: customer.id, isDefault: true },
      data: { isDefault: false },
    });

    await prisma.paymentMethod.create({
      data: {
        customerId: customer.id,
        lunarpayPaymentMethodId: lp.data.id,
        sourceType: lp.data.sourceType,
        lastDigits: lp.data.lastDigits ?? null,
        nameHolder: lp.data.nameHolder ?? null,
        expMonth: lp.data.expMonth ?? null,
        expYear: lp.data.expYear ?? null,
        isDefault: true,
      },
    });
    await prisma.checkoutSession.update({
      where: { id: sess.id },
      data: { status: "completed", completedAt: new Date() },
    });
    await logAudit({
      actorId: null,
      actorRole: "CUSTOMER",
      clinicId: sess.clinicId,
      action: "payment_method.create.self_service",
      targetType: "Customer",
      targetId: customer.id,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const status = e instanceof LunarPayError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Failed to save card";
    return NextResponse.json({ error: msg }, { status });
  }
}
