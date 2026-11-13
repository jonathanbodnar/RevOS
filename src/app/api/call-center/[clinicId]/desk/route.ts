import { NextResponse } from "next/server";
import { buildDesk } from "@/lib/call-center/desk-server";
import { clinicRoute } from "@/lib/call-center/route-helpers";

export const dynamic = "force-dynamic";

/** The Today screen: day's list, current lead, tally, rules. `?focus=<leadId>` opens a lead. */
export async function GET(req: Request, ctx: { params: Promise<{ clinicId: string }> }) {
  const r = await clinicRoute(ctx.params);
  if ("error" in r) return r.error;
  const focus = new URL(req.url).searchParams.get("focus");
  const desk = await buildDesk({
    clinicId: r.clinicId,
    userId: r.session.user.id,
    now: new Date(),
    focusLeadId: focus && /^[a-z0-9]{10,40}$/i.test(focus) ? focus : null,
  });
  return NextResponse.json({ data: desk });
}
