import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { requireStringParams } from "@/lib/route-params";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * Set which providers are assigned to a customer. Clinic admins (and super
 * admins) manage this; providers cannot reassign themselves.
 */
const Body = z.object({ providerIds: z.array(z.string()).max(100) });

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const guard = await requireClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;

  // Providers may not manage assignments.
  if (session.user.originalRole === "PROVIDER") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const params = await requireStringParams(ctx.params, ["id"] as const);
  if (!params.ok) return params.response;
  const { id } = params.value;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const customer = await prisma.customer.findFirst({
    where: { id, clinicId },
    select: { id: true },
  });
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  // Only accept providers that actually belong to this clinic.
  const validProviders = await prisma.user.findMany({
    where: { id: { in: parsed.data.providerIds }, role: "PROVIDER", clinicId },
    select: { id: true },
  });
  const validIds = new Set(validProviders.map((p) => p.id));

  await prisma.$transaction(async (tx) => {
    await tx.customerProviderAssignment.deleteMany({
      where: { customerId: customer.id, providerId: { notIn: [...validIds] } },
    });
    for (const providerId of validIds) {
      await tx.customerProviderAssignment.upsert({
        where: { providerId_customerId: { providerId, customerId: customer.id } },
        create: {
          providerId,
          customerId: customer.id,
          clinicId,
          assignedById: session.user.id,
        },
        update: {},
      });
    }
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId,
    action: "customer.providers.set",
    targetType: "Customer",
    targetId: customer.id,
    metadata: { providerIds: [...validIds] },
  });

  return NextResponse.json({ data: { providerIds: [...validIds] } });
}
