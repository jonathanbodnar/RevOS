import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { requireCallCenterAdminApi } from "@/lib/call-center/access";
import { requireStringParams } from "@/lib/route-params";

export const dynamic = "force-dynamic";

/**
 * Take a number off a clinic in RevOS. It stays in the Telnyx account (and
 * keeps billing) until someone releases it in the Telnyx portal.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = await requireCallCenterAdminApi();
  if ("error" in g) return g.error;
  const p = await requireStringParams(ctx.params, ["id"] as const);
  if (!p.ok) return p.response;
  const row = await prisma.clinicPhoneNumber.findUnique({ where: { id: p.value.id } });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.clinicPhoneNumber.delete({ where: { id: row.id } });
  if (row.isDefault) {
    const next = await prisma.clinicPhoneNumber.findFirst({ where: { clinicId: row.clinicId }, orderBy: { createdAt: "asc" } });
    if (next) await prisma.clinicPhoneNumber.update({ where: { id: next.id }, data: { isDefault: true } });
  }
  await logAudit({
    actorId: g.session.user.id,
    actorRole: g.session.user.originalRole,
    clinicId: row.clinicId,
    action: "telnyx.number_unassign",
    targetType: "ClinicPhoneNumber",
    targetId: row.id,
    metadata: { number: row.e164 },
  });
  return NextResponse.json({ data: { ok: true } });
}
