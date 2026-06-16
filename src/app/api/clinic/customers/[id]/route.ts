import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSuperAdminClinicApi } from "@/lib/api-guard";
import { requireStringParams } from "@/lib/route-params";
import { logAudit } from "@/lib/audit";
import { lunarpay } from "@/lib/lunarpay";

const PatchBody = z.object({
  implementorId: z.string().nullable().optional(),
  paymentNotes: z.string().max(2000).nullable().optional(),
  firstName: z.string().max(120).nullable().optional(),
  lastName: z.string().max(120).nullable().optional(),
  email: z.string().email().max(255).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
});

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const guard = await requireSuperAdminClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;

  const params = await requireStringParams(ctx.params, ["id"] as const);
  if (!params.ok) return params.response;
  const { id } = params.value;

  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const customer = await prisma.customer.findFirst({ where: { id, clinicId } });
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  // Validate implementor if one is being set.
  if (parsed.data.implementorId) {
    const impl = await prisma.implementor.findUnique({
      where: { id: parsed.data.implementorId },
    });
    if (!impl) {
      return NextResponse.json({ error: "Implementor not found" }, { status: 404 });
    }
  }

  const d = parsed.data;
  const profileChanged =
    d.firstName !== undefined ||
    d.lastName !== undefined ||
    d.email !== undefined ||
    d.phone !== undefined;

  // Keep LunarPay's customer record in sync so receipts / dashboards match.
  // Non-fatal — a LunarPay hiccup shouldn't block updating our own record.
  if (profileChanged && customer.lunarpayCustomerId) {
    try {
      await lunarpay.updateCustomer(customer.lunarpayCustomerId, {
        ...(d.firstName !== undefined ? { firstName: d.firstName ?? "" } : {}),
        ...(d.lastName !== undefined ? { lastName: d.lastName ?? "" } : {}),
        ...(d.email !== undefined ? { email: d.email ?? "" } : {}),
        ...(d.phone !== undefined ? { phone: d.phone ?? "" } : {}),
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[customer.update] LunarPay sync failed", e);
    }
  }

  const updated = await prisma.customer.update({
    where: { id },
    data: {
      ...(d.implementorId !== undefined ? { implementorId: d.implementorId } : {}),
      ...(d.paymentNotes !== undefined ? { paymentNotes: d.paymentNotes } : {}),
      ...(d.firstName !== undefined ? { firstName: d.firstName } : {}),
      ...(d.lastName !== undefined ? { lastName: d.lastName } : {}),
      ...(d.email !== undefined ? { email: d.email } : {}),
      ...(d.phone !== undefined ? { phone: d.phone } : {}),
    },
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId,
    action: profileChanged ? "customer.update.profile" : "customer.update.reporting",
    targetType: "Customer",
    targetId: id,
    metadata: {
      implementorId: d.implementorId,
      hasNotes: d.paymentNotes != null,
      profileChanged,
    },
  });

  return NextResponse.json({ data: { id: updated.id } });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const guard = await requireSuperAdminClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;

  const params = await requireStringParams(ctx.params, ["id"] as const);
  if (!params.ok) return params.response;
  const { id } = params.value;

  const customer = await prisma.customer.findFirst({
    where: { id, clinicId },
  });
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  await prisma.customer.delete({ where: { id } });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId,
    action: "customer.delete",
    targetType: "Customer",
    targetId: id,
    metadata: {
      email: customer.email,
      name: [customer.firstName, customer.lastName].filter(Boolean).join(" "),
    },
  });

  return NextResponse.json({ success: true });
}
