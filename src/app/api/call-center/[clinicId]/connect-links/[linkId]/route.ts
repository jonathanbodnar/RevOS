import { NextResponse } from "next/server";
import { requireCallCenterApi } from "@/lib/call-center/access";
import { revokeConnectLink } from "@/lib/call-center/connect-link";
import { logAudit } from "@/lib/audit";
import { requireStringParams } from "@/lib/route-params";

export const dynamic = "force-dynamic";

/** Revoke a link right away. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ clinicId: string; linkId: string }> }) {
  const params = await requireStringParams(ctx.params, ["clinicId", "linkId"] as const);
  if (!params.ok) return params.response;
  const guard = await requireCallCenterApi(params.value.clinicId);
  if ("error" in guard) return guard.error;
  const revoked = await revokeConnectLink(guard.clinicId, params.value.linkId);
  if (!revoked) return NextResponse.json({ error: "Link not found" }, { status: 404 });
  await logAudit({
    actorId: guard.session.user.id,
    actorRole: guard.session.user.originalRole,
    clinicId: guard.clinicId,
    action: "connect_link.revoke",
    targetType: "ClinicConnectLink",
    targetId: params.value.linkId,
  });
  return NextResponse.json({ ok: true });
}
