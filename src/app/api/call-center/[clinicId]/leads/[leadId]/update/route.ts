import { NextResponse } from "next/server";
import { z } from "zod";
import { markLead } from "@/lib/call-center/desk-server";
import { bad, clinicRoute, readJson } from "@/lib/call-center/route-helpers";
import { MARKS, STAGES } from "@/lib/call-center/stages";

export const dynamic = "force-dynamic";

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("mark"), mark: z.enum(MARKS) }),
  z.object({ action: z.literal("stage"), stage: z.enum(STAGES) }),
  z.object({ action: z.literal("priority"), priority: z.boolean() }),
  z.object({ action: z.literal("appt"), apptLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/) }),
]);

/** "Update without a call": showed / clinic cancelled / no-show, status, priority, appointment time. */
export async function POST(req: Request, ctx: { params: Promise<{ clinicId: string; leadId: string }> }) {
  const r = await clinicRoute(ctx.params, ["leadId"] as const);
  if ("error" in r) return r.error;
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) return bad("Invalid input");
  const res = await markLead({ clinicId: r.clinicId, userId: r.session.user.id, leadId: r.params.leadId, now: new Date(), ...parsed.data });
  if (!res.ok) return bad(res.error, res.status);
  return NextResponse.json({ data: { message: res.message } });
}
