import { NextResponse } from "next/server";
import { z } from "zod";
import { afterOutcome } from "@/lib/call-center/dialer";
import { logOutcome } from "@/lib/call-center/desk-server";
import { bad, clinicRoute, readJson } from "@/lib/call-center/route-helpers";
import { CALL_OUTCOMES, QUEUE_KINDS, TOUCHES } from "@/lib/call-center/stages";

export const dynamic = "force-dynamic";

const Body = z.object({
  kind: z.enum([...QUEUE_KINDS, "manual", "inbound"]),
  touch: z.enum(TOUCHES).optional().nullable(),
  outcome: z.enum(CALL_OUTCOMES),
  scheduledLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional().nullable(),
  note: z.string().max(2000).optional().nullable(),
  redial: z.boolean().optional(),
  callId: z.string().max(40).optional().nullable(),
});

/** Log the result of a call (the outcome buttons on the desk). */
export async function POST(req: Request, ctx: { params: Promise<{ clinicId: string; leadId: string }> }) {
  const r = await clinicRoute(ctx.params, ["leadId"] as const);
  if ("error" in r) return r.error;
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) return bad("Invalid input");
  const res = await logOutcome({
    clinicId: r.clinicId,
    userId: r.session.user.id,
    leadId: r.params.leadId,
    ...parsed.data,
    now: new Date(),
  });
  if (!res.ok) return bad(res.error, res.status);
  // Free the phone line for the next call (and keep going in auto mode).
  if (parsed.data.outcome !== "note") await afterOutcome(r.session.user.id, parsed.data.callId ?? null);
  return NextResponse.json({ data: { message: res.message, advance: res.advance, redialNext: res.redialNext } });
}
