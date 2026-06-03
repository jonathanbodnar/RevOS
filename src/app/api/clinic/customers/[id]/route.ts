import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSuperAdminClinicApi } from "@/lib/api-guard";
import { requireStringParams } from "@/lib/route-params";
import { logAudit } from "@/lib/audit";

const PatchBody = z.object({
  implementorId: z.string().nullable().optional(),
  paymentNotes: z.string().max(2000).nullable().optional(),
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

  const updated = await prisma.customer.update({
    where: { id },
    data: {
      ...(parsed.data.implementorId !== undefined
        ? { implementorId: parsed.data.implementorId }
        : {}),
      ...(parsed.data.paymentNotes !== undefined
        ? { paymentNotes: parsed.data.paymentNotes }
        : {}),
    },
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId,
    action: "customer.update.reporting",
    targetType: "Customer",
    targetId: id,
    metadata: {
      implementorId: parsed.data.implementorId,
      hasNotes: parsed.data.paymentNotes != null,
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
