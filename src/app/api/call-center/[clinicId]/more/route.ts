import { NextResponse } from "next/server";
import { addFreshLeads } from "@/lib/call-center/desk-server";
import { clinicRoute } from "@/lib/call-center/route-helpers";

export const dynamic = "force-dynamic";

/** "Add 25 new leads" to today's list. */
export async function POST(_req: Request, ctx: { params: Promise<{ clinicId: string }> }) {
  const r = await clinicRoute(ctx.params);
  if ("error" in r) return r.error;
  await addFreshLeads(r.clinicId, new Date(), 25);
  return NextResponse.json({ data: { ok: true } });
}
