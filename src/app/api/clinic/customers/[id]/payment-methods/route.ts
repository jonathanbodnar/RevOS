import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { logAudit } from "@/lib/audit";

const Body = z.object({
  ticketId: z.string().min(1),
  paymentMethod: z.enum(["cc", "ach"]).optional(),
  nameHolder: z.string().optional(),
  setDefault: z.boolean().optional(),
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

  const customer = await prisma.customer.findFirst({
    where: { id, clinicId },
  });
  if (!customer || !customer.lunarpayCustomerId) {
    return NextResponse.json(
      { error: "Customer has no LunarPay id yet." },
      { status: 400 },
    );
  }

  try {
    const pmCount = await prisma.paymentMethod.count({
      where: { customerId: customer.id, isActive: true },
    });
    const setDefault = parsed.data.setDefault ?? pmCount === 0;

    const lp = await lunarpay.savePaymentMethod(customer.lunarpayCustomerId, {
      ticketId: parsed.data.ticketId,
      paymentMethod: parsed.data.paymentMethod,
      nameHolder: parsed.data.nameHolder,
      setDefault,
    });

    if (setDefault) {
      await prisma.paymentMethod.updateMany({
        where: { customerId: customer.id, isDefault: true },
        data: { isDefault: false },
      });
    }

    const pm = await prisma.paymentMethod.create({
      data: {
        customerId: customer.id,
        lunarpayPaymentMethodId: lp.data.id,
        sourceType: lp.data.sourceType,
        lastDigits: lp.data.lastDigits ?? null,
        nameHolder: lp.data.nameHolder ?? null,
        expMonth: lp.data.expMonth ?? null,
        expYear: lp.data.expYear ?? null,
        isDefault: !!lp.data.isDefault || setDefault,
      },
    });

    await logAudit({
      actorId: session.user.id,
      actorRole: session.user.originalRole,
      clinicId,
      action: "payment_method.create",
      targetType: "PaymentMethod",
      targetId: pm.id,
    });

    return NextResponse.json({ data: { id: pm.id } }, { status: 201 });
  } catch (e) {
    const status = e instanceof LunarPayError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Failed to save card.";
    return NextResponse.json({ error: msg }, { status });
  }
}
