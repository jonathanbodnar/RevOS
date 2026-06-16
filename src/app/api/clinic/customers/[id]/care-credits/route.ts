import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSuperAdminClinicApi } from "@/lib/api-guard";
import { logAudit } from "@/lib/audit";
import { parseMoneyInputToCents } from "@/lib/format";

/**
 * Log a Care Credit payment for a customer.
 *
 * Care Credit is money the patient paid the clinic directly via external
 * financing — RevOS never runs a card. It's a manual log only, surfaced in the
 * reporting center where it's split like a down payment (and reduces what RevOS
 * owes the clinic by RevOS's share).
 */
const Body = z.object({
  amount: z.string().min(1),
  collectedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
  note: z.string().max(500).optional(),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const guard = await requireSuperAdminClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;
  const { id } = await ctx.params;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "Invalid input" },
      { status: 400 },
    );
  }
  const cents = parseMoneyInputToCents(parsed.data.amount);
  if (cents === null || cents < 1) {
    return NextResponse.json(
      { error: "Enter a valid amount." },
      { status: 400 },
    );
  }

  const customer = await prisma.customer.findFirst({ where: { id, clinicId } });
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  const cc = await prisma.careCredit.create({
    data: {
      clinicId,
      customerId: customer.id,
      amountCents: cents,
      collectedOn: new Date(`${parsed.data.collectedOn}T12:00:00Z`),
      note: parsed.data.note?.trim() || null,
      source: "manual",
      createdById: session.user.id,
    },
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId,
    action: "care_credit.create",
    targetType: "CareCredit",
    targetId: cc.id,
    metadata: { customerId: customer.id, amountCents: cents },
  });

  return NextResponse.json({ data: { id: cc.id } }, { status: 201 });
}
