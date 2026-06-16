import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSuperAdminClinicApi } from "@/lib/api-guard";
import { requireStringParams } from "@/lib/route-params";
import { logAudit } from "@/lib/audit";

/**
 * Merge a duplicate patient profile INTO the one being viewed.
 *
 * `[id]` is the PRIMARY profile we keep; `sourceCustomerId` is the duplicate
 * that gets emptied out and deleted. Every payment artifact (cards, charges,
 * subscriptions, schedules, checkout sessions, advanced costs, care credits)
 * is repointed to the primary. Saved cards keep their lunarpayCustomerId owner
 * so they remain chargeable after the move.
 */
const Body = z.object({
  sourceCustomerId: z.string().min(1),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const guard = await requireSuperAdminClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;

  const params = await requireStringParams(ctx.params, ["id"] as const);
  if (!params.ok) return params.response;
  const { id } = params.value;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const { sourceCustomerId } = parsed.data;

  if (sourceCustomerId === id) {
    return NextResponse.json(
      { error: "Pick a different profile to merge in." },
      { status: 400 },
    );
  }

  const [primary, source] = await Promise.all([
    prisma.customer.findFirst({ where: { id, clinicId } }),
    prisma.customer.findFirst({ where: { id: sourceCustomerId, clinicId } }),
  ]);
  if (!primary) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }
  if (!source) {
    return NextResponse.json(
      { error: "Profile to merge not found in this clinic." },
      { status: 404 },
    );
  }

  const primaryHasDefault = await prisma.paymentMethod.count({
    where: { customerId: primary.id, isActive: true, isDefault: true },
  });

  await prisma.$transaction(async (tx) => {
    // Cards: if the primary already has a default, the moved cards must not
    // also be default (only one default per profile).
    await tx.paymentMethod.updateMany({
      where: { customerId: source.id },
      data: {
        customerId: primary.id,
        ...(primaryHasDefault > 0 ? { isDefault: false } : {}),
      },
    });

    await tx.charge.updateMany({
      where: { customerId: source.id },
      data: { customerId: primary.id },
    });
    await tx.subscription.updateMany({
      where: { customerId: source.id },
      data: { customerId: primary.id },
    });
    await tx.paymentSchedule.updateMany({
      where: { customerId: source.id },
      data: { customerId: primary.id },
    });
    await tx.checkoutSession.updateMany({
      where: { customerId: source.id },
      data: { customerId: primary.id },
    });
    await tx.advancedCost.updateMany({
      where: { customerId: source.id },
      data: { customerId: primary.id },
    });
    await tx.careCredit.updateMany({
      where: { customerId: source.id },
      data: { customerId: primary.id },
    });

    // Carry over attribution / notes / contact gaps from the duplicate.
    const mergedNotes = [primary.paymentNotes, source.paymentNotes]
      .filter(Boolean)
      .join("\n");
    await tx.customer.update({
      where: { id: primary.id },
      data: {
        implementorId: primary.implementorId ?? source.implementorId,
        email: primary.email ?? source.email,
        phone: primary.phone ?? source.phone,
        firstName: primary.firstName ?? source.firstName,
        lastName: primary.lastName ?? source.lastName,
        paymentNotes: mergedNotes || null,
      },
    });

    // Detach the duplicate's LunarPay id (unique) before deleting so it never
    // collides, then remove the now-empty profile.
    await tx.customer.update({
      where: { id: source.id },
      data: { lunarpayCustomerId: null },
    });
    await tx.customer.delete({ where: { id: source.id } });
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId,
    action: "customer.merge",
    targetType: "Customer",
    targetId: primary.id,
    metadata: {
      mergedFromCustomerId: source.id,
      mergedFromName:
        [source.firstName, source.lastName].filter(Boolean).join(" ") ||
        source.email,
    },
  });

  return NextResponse.json({ ok: true, data: { id: primary.id } });
}
