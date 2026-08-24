import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireClinicApi, requireSuperAdminClinicApi } from "@/lib/api-guard";
import { customerScopeWhere } from "@/lib/roles";
import { requireStringParams } from "@/lib/route-params";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { logAudit } from "@/lib/audit";

export async function PATCH(
  _req: Request,
  ctx: { params: Promise<{ id: string; pmId: string }> },
) {
  const guard = await requireClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;

  const params = await requireStringParams(ctx.params, ["id", "pmId"] as const);
  if (!params.ok) return params.response;
  const { id, pmId } = params.value;

  const customer = await prisma.customer.findFirst({
    where: { id, ...customerScopeWhere(session.user, clinicId) },
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
  const guard = await requireSuperAdminClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;

  const params = await requireStringParams(ctx.params, ["id", "pmId"] as const);
  if (!params.ok) return params.response;
  const { id, pmId } = params.value;

  // No lunarpayCustomerId requirement here: the CARD's vault owner is what
  // matters, and a profile that lost its own LunarPay id must still be able to
  // drop stale cards.
  const customer = await prisma.customer.findFirst({
    where: { id, clinicId },
  });
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }
  const pm = await prisma.paymentMethod.findFirst({
    where: { id: pmId, customerId: customer.id },
  });
  if (!pm) {
    return NextResponse.json({ error: "Payment method not found" }, { status: 404 });
  }

  // A vaulted card lives under exactly ONE LunarPay customer, and after a
  // profile merge that is not this profile's own vault — which is why
  // PaymentMethod.lunarpayCustomerId records the real owner. Deleting via the
  // customer's id 404s at LunarPay's ownership-scoped route, which is what made
  // merged patients' cards impossible to remove.
  const vaultOwnerId = pm.lunarpayCustomerId ?? customer.lunarpayCustomerId;

  let detached: "deleted" | "already-gone" | "unlinked" = "deleted";
  if (vaultOwnerId) {
    try {
      await lunarpay.deletePaymentMethod(vaultOwnerId, pm.lunarpayPaymentMethodId);
    } catch (e) {
      // 404 means LunarPay has no such card under that vault — already deleted
      // there, or vaulted somewhere we can no longer address. Every charge path
      // resolves the owner with this same expression, so the row is provably
      // unchargeable; deactivate locally rather than stranding the user with a
      // card they can never remove. Anything else (401/403/5xx) still fails
      // hard: marking a card gone while it stays live at LunarPay would be
      // worse than the bug being fixed.
      if (e instanceof LunarPayError && e.status === 404) {
        detached = "already-gone";
      } else {
        const status = e instanceof LunarPayError ? e.status : 500;
        const msg = e instanceof Error ? e.message : "Failed to remove.";
        return NextResponse.json({ error: msg }, { status });
      }
    }
  } else {
    detached = "unlinked";
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
    metadata: {
      lunarpayCustomerId: vaultOwnerId,
      lunarpayPaymentMethodId: pm.lunarpayPaymentMethodId,
      detached,
    },
  });

  return NextResponse.json({ ok: true, data: { detached } });
}
