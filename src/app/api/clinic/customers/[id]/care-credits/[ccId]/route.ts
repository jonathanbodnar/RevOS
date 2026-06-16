import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSuperAdminClinicApi } from "@/lib/api-guard";
import { requireStringParams } from "@/lib/route-params";
import { logAudit } from "@/lib/audit";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; ccId: string }> },
) {
  const guard = await requireSuperAdminClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;

  const params = await requireStringParams(ctx.params, ["id", "ccId"] as const);
  if (!params.ok) return params.response;
  const { id, ccId } = params.value;

  const cc = await prisma.careCredit.findFirst({
    where: { id: ccId, customerId: id, clinicId },
  });
  if (!cc) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  await prisma.careCredit.delete({ where: { id: cc.id } });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId,
    action: "care_credit.delete",
    targetType: "CareCredit",
    targetId: cc.id,
    metadata: { customerId: id, amountCents: cc.amountCents },
  });

  return NextResponse.json({ ok: true });
}
