import { NextResponse } from "next/server";
import { skipLead } from "@/lib/call-center/desk-server";
import { clinicRoute } from "@/lib/call-center/route-helpers";

export const dynamic = "force-dynamic";

/** "Skip for now": to the end of today's list. */
export async function POST(_req: Request, ctx: { params: Promise<{ clinicId: string; leadId: string }> }) {
  const r = await clinicRoute(ctx.params, ["leadId"] as const);
  if ("error" in r) return r.error;
  const ok = await skipLead(r.clinicId, r.session.user.id, r.params.leadId, new Date());
  if (!ok) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  return NextResponse.json({ data: { ok: true } });
}
