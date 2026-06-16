import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSuperAdminClinicApi } from "@/lib/api-guard";
import { requireStringParams } from "@/lib/route-params";
import { logAudit } from "@/lib/audit";

/**
 * Reassign a saved card from one patient profile to another within the same
 * clinic.
 *
 * A vaulted card physically lives under ONE LunarPay customer, and LunarPay has
 * no "move card" endpoint (re-vaulting needs the raw card again). So we move the
 * card locally and PRESERVE its real vault owner in PaymentMethod.lunarpayCustomerId.
 * Every charge path reads `pm.lunarpayCustomerId ?? customer.lunarpayCustomerId`,
 * so the reassigned card keeps charging the correct underlying card — the
 * revenue is just now attributed to the target patient in RevOS.
 */
const Body = z.object({
  targetCustomerId: z.string().min(1),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string; pmId: string }> },
) {
  const guard = await requireSuperAdminClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;

  const params = await requireStringParams(ctx.params, ["id", "pmId"] as const);
  if (!params.ok) return params.response;
  const { id, pmId } = params.value;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const { targetCustomerId } = parsed.data;

  if (targetCustomerId === id) {
    return NextResponse.json(
      { error: "That card already belongs to this patient." },
      { status: 400 },
    );
  }

  const source = await prisma.customer.findFirst({ where: { id, clinicId } });
  if (!source) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }
  const target = await prisma.customer.findFirst({
    where: { id: targetCustomerId, clinicId },
  });
  if (!target) {
    return NextResponse.json(
      { error: "Target patient not found in this clinic." },
      { status: 404 },
    );
  }

  const pm = await prisma.paymentMethod.findFirst({
    where: { id: pmId, customerId: source.id, isActive: true },
  });
  if (!pm) {
    return NextResponse.json({ error: "Payment method not found" }, { status: 404 });
  }

  // Preserve the real vault owner so charges keep working after the move.
  const owner = pm.lunarpayCustomerId ?? source.lunarpayCustomerId;

  const targetHasDefault = await prisma.paymentMethod.count({
    where: { customerId: target.id, isActive: true, isDefault: true },
  });

  await prisma.$transaction(async (tx) => {
    await tx.paymentMethod.update({
      where: { id: pm.id },
      data: {
        customerId: target.id,
        lunarpayCustomerId: owner,
        // Only auto-default on the target if it has none yet.
        isDefault: targetHasDefault === 0,
      },
    });

    // If we removed the source's default, promote its most recent remaining card.
    if (pm.isDefault) {
      const next = await tx.paymentMethod.findFirst({
        where: { customerId: source.id, isActive: true },
        orderBy: { createdAt: "desc" },
      });
      if (next) {
        await tx.paymentMethod.update({
          where: { id: next.id },
          data: { isDefault: true },
        });
      }
    }
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId,
    action: "payment_method.reassign",
    targetType: "PaymentMethod",
    targetId: pm.id,
    metadata: {
      fromCustomerId: source.id,
      toCustomerId: target.id,
      lunarpayCustomerOwner: owner,
    },
  });

  return NextResponse.json({ ok: true, data: { customerId: target.id } });
}
