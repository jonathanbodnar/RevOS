import { NextResponse } from "next/server";
import { buildReport } from "@/lib/call-center/desk-server";
import { clinicRoute } from "@/lib/call-center/route-helpers";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ clinicId: string }> }) {
  const r = await clinicRoute(ctx.params);
  if ("error" in r) return r.error;
  const day = new URL(req.url).searchParams.get("day");
  return NextResponse.json({ data: await buildReport(r.clinicId, new Date(), day) });
}
