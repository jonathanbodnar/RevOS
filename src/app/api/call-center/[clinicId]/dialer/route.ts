import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import {
  DialerError,
  endSession,
  getSetup,
  hangupCurrent,
  manualDial,
  openSession,
  pauseAuto,
  sessionState,
  setMode,
  startSession,
  SESSION_HEADER,
} from "@/lib/call-center/dialer";
import { bad, clinicRoute, readJson } from "@/lib/call-center/route-helpers";
import { QUEUE_KINDS, TOUCHES, leadName } from "@/lib/call-center/stages";

export const dynamic = "force-dynamic";

/** The agent's phone line on this clinic: polled by the desk (also the heartbeat). */
export async function GET(_req: Request, ctx: { params: Promise<{ clinicId: string }> }) {
  const r = await clinicRoute(ctx.params);
  if ("error" in r) return r.error;
  const setup = await getSetup();
  const numbers = await prisma.clinicPhoneNumber.findMany({ where: { clinicId: r.clinicId }, select: { e164: true, isDefault: true } });
  const s = await sessionState(r.session.user.id);
  const session = s && s.clinicId === r.clinicId ? s : null;
  let lead = null;
  if (session?.currentLeadId) {
    const l = await prisma.lead.findFirst({ where: { id: session.currentLeadId, clinicId: r.clinicId }, select: { id: true, firstName: true, lastName: true, phone: true } });
    if (l) lead = { id: l.id, name: leadName(l), phone: l.phone };
  }
  return NextResponse.json({
    data: {
      ready: setup.configured && numbers.length > 0,
      setup: { configured: setup.configured, apiKey: setup.apiKey, webhookKey: setup.webhookKey },
      numbers,
      sessionHeader: SESSION_HEADER,
      // Live on a different clinic: the desk offers to switch.
      elsewhere: s && s.clinicId !== r.clinicId ? { clinicId: s.clinicId } : null,
      session: session
        ? {
            id: session.id,
            mode: session.mode,
            status: session.status,
            lastError: session.lastError,
            call: session.call
              ? {
                  id: session.call.id,
                  status: session.call.status,
                  direction: session.call.direction,
                  dialNumber: session.call.dialNumber,
                  kind: session.call.kind,
                  touch: session.call.touch,
                  startedAt: session.call.startedAt,
                  answeredAt: session.call.answeredAt,
                  bridgedAt: session.call.bridgedAt,
                  endedAt: session.call.endedAt,
                  hangupCause: session.call.hangupCause,
                  amdResult: session.call.amdResult,
                  error: session.call.error,
                }
              : null,
            lead,
          }
        : null,
    },
  });
}

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start"), mode: z.enum(["manual", "auto"]) }),
  z.object({ action: z.literal("end") }),
  z.object({ action: z.literal("auto") }),
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("hangup") }),
  z.object({
    action: z.literal("dial"),
    leadId: z.string().min(10).max(40),
    kind: z.enum([...QUEUE_KINDS, "manual", "inbound"]),
    touch: z.enum(TOUCHES).optional().nullable(),
    redial: z.boolean().optional(),
  }),
]);

export async function POST(req: Request, ctx: { params: Promise<{ clinicId: string }> }) {
  const r = await clinicRoute(ctx.params);
  if ("error" in r) return r.error;
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) return bad("Invalid input");
  const userId = r.session.user.id;
  const audit = (action: string, metadata?: Record<string, unknown>) =>
    logAudit({ actorId: userId, actorRole: r.session.user.originalRole, clinicId: r.clinicId, action, targetType: "DialerSession", metadata });
  try {
    switch (parsed.data.action) {
      case "start": {
        const { session, dialTarget } = await startSession({ clinicId: r.clinicId, userId, mode: parsed.data.mode });
        await audit("dialer.start", { mode: parsed.data.mode });
        return NextResponse.json({ data: { sessionId: session.id, dialTarget, header: SESSION_HEADER } });
      }
      case "end": {
        const s = await openSession(userId);
        if (s) await endSession(s.id);
        return NextResponse.json({ data: { ok: true } });
      }
      case "auto":
        await setMode(userId, "auto");
        await audit("dialer.auto_start");
        return NextResponse.json({ data: { ok: true } });
      case "pause":
        await pauseAuto(userId);
        return NextResponse.json({ data: { ok: true } });
      case "hangup":
        await hangupCurrent(userId);
        return NextResponse.json({ data: { ok: true } });
      case "dial": {
        const callId = await manualDial({ clinicId: r.clinicId, userId, leadId: parsed.data.leadId, kind: parsed.data.kind, touch: parsed.data.touch ?? null, redial: parsed.data.redial });
        return NextResponse.json({ data: { callId } });
      }
    }
  } catch (e) {
    if (e instanceof DialerError) return bad(e.message, e.status);
    throw e;
  }
}
