import { NextResponse } from "next/server";
import { leadDetail } from "@/lib/call-center/desk-server";
import { clinicRoute } from "@/lib/call-center/route-helpers";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ clinicId: string; leadId: string }> }) {
  const r = await clinicRoute(ctx.params, ["leadId"] as const);
  if ("error" in r) return r.error;
  const detail = await leadDetail(r.clinicId, r.params.leadId, new Date());
  if (!detail) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  return NextResponse.json({ data: detail });
}
