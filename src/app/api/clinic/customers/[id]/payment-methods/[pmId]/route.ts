import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { logAudit } from "@/lib/audit";

export async function PATCH(
  _req: Request,
  ctx: { params: Promise<{ id: string; pmId: string }> },
) {
  const guard = await requireClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;
  const { id, pmId } = await ctx.params;

  const customer = await prisma.customer.findFirst({
    where: { id, clinicId },
  });
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }
  const pm = await prisma.paymentMethod.findFirst({
    where: { id: pmId, customerId: customer.id, isActive: true },
  });
  if (!pm) {
    return NextResponse.json({ error: "Payment method not found" }, { status: 404 });
  }

  // Clear current default then set the new one.
  await prisma.paymentMethod.updateMany({
    where: { customerId: customer.id, isDefault: true },
    data: { isDefault: false },
  });
  await prisma.paymentMethod.update({
    where: { id: pm.id },
    data: { isDefault: true },
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId,
    action: "payment_method.set_default",
    targetType: "PaymentMethod",
    targetId: pm.id,
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; pmId: string }> },
) {
  const guard = await requireClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;
  const { id, pmId } = await ctx.params;

  const customer = await prisma.customer.findFirst({
    where: { id, clinicId },
  });
  if (!customer || !customer.lunarpayCustomerId) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }
  const pm = await prisma.paymentMethod.findFirst({
    where: { id: pmId, customerId: customer.id },
  });
  if (!pm) {
    return NextResponse.json({ error: "Payment method not found" }, { status: 404 });
  }

  try {
    await lunarpay.deletePaymentMethod(
      customer.lunarpayCustomerId,
      pm.lunarpayPaymentMethodId,
    );
  } catch (e) {
    const status = e instanceof LunarPayError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Failed to remove.";
    return NextResponse.json({ error: msg }, { status });
  }

  await prisma.paymentMethod.update({
    where: { id: pm.id },
    data: { isActive: false, isDefault: false },
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId,
    action: "payment_method.delete",
    targetType: "PaymentMethod",
    targetId: pm.id,
  });

  return NextResponse.json({ ok: true });
}
