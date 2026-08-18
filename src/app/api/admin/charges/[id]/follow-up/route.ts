import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperAdminApi } from "@/lib/api-guard";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { FOLLOW_UP_STATUSES } from "@/lib/follow-up";

export const dynamic = "force-dynamic";

const Body = z.object({
  followUpStatus: z.enum(FOLLOW_UP_STATUSES),
  note: z.string().trim().max(500).nullable().optional(),
  // A single decline is often recorded twice (the payment-link path mints a
  // synthetic id, the LunarPay webhook writes the real transaction id), so one
  // patient can show several rows for one real event. Opt in to applying the
  // same outcome to that customer's other still-untouched failed charges.
  cascade: z.boolean().optional(),
});

/** Set the collections follow-up state on a failed charge. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireSuperAdminApi();
  if ("error" in guard) return guard.error;
  const { id } = await params;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const { followUpStatus, note, cascade } = parsed.data;

  const charge = await prisma.charge.findUnique({
    where: { id },
    select: { id: true, clinicId: true, customerId: true, status: true, followUpStatus: true },
  });
  if (!charge) return NextResponse.json({ error: "Charge not found" }, { status: 404 });

  const data = {
    followUpStatus,
    followUpAt: new Date(),
    followUpById: guard.session.user.id ?? null,
    ...(note !== undefined ? { followUpNote: note } : {}),
  };

  await prisma.charge.update({ where: { id }, data });

  let cascaded = 0;
  if (cascade) {
    const { count } = await prisma.charge.updateMany({
      where: {
        customerId: charge.customerId,
        status: "failed",
        followUpStatus: "new",
        id: { not: id },
      },
      data,
    });
    cascaded = count;
  }

  await logAudit({
    actorId: guard.session.user.id ?? null,
    actorRole: guard.session.user.originalRole,
    clinicId: charge.clinicId,
    action: "charge.follow_up",
    targetType: "Charge",
    targetId: charge.id,
    metadata: {
      from: charge.followUpStatus,
      to: followUpStatus,
      hasNote: Boolean(note),
      cascaded,
    },
  });

  return NextResponse.json({ ok: true, followUpStatus, cascaded });
}
