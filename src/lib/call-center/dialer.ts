/**
 * The dialer: manual click-to-call and the auto dialer, on Telnyx Call Control.
 *
 * Design (Telnyx's documented outbound-dialer pattern):
 *   1. The agent's browser phone (Telnyx WebRTC SDK, JWT login) places one call
 *      when they go live. Its credential connection has call parking on, so
 *      Telnyx parks that call and sends `call.initiated` here. We find the
 *      DialerSession from the X-RevOS-Session SIP header, answer the leg, and
 *      keep it: this is the agent's line for the whole session.
 *   2. Each lead is dialed with POST /calls on the Call Control application,
 *      from the clinic's Telnyx number. The lead leg is bridged onto the
 *      agent's line with park_after_unbridge=self, so when the lead hangs up the
 *      agent's line stays up for the next call.
 *        - Manual: bridged as soon as it starts ringing (the agent hears the
 *          ringback and the greeting, exactly like dialing themselves).
 *        - Auto: bridged when the person answers, or — with "skip voicemail" on
 *          — when answering machine detection says it's a person. Machines are
 *          hung up (no voicemails, per protocol) and logged as voicemail.
 *   3. Auto mode is progressive: one call at a time per agent, so a person who
 *      answers is always connected to a live agent (no abandoned calls). A
 *      no-answer on the first dial is redialed right away when the clinic's
 *      rules say double-dial; then the next lead in list order.
 *   4. Patients calling a clinic number ring the first free agent working that
 *      clinic. With nobody free they hear a short message, and the lead goes to
 *      the top of Callbacks.
 *
 * Every guard runs on the server for every dial: calling hours (clinic time,
 * never Sunday), do-not-call, the per-person 24-hour cap, written consent for
 * auto-dial, and the lead claim so two agents never ring the same person.
 * State lives in the DB (DialerSession, LeadCall); webhook handlers move it
 * with conditional updates so retried or out-of-order events are harmless.
 */
import { prisma } from "../prisma";
import { normalizePhone } from "../phone";
import { loadRules } from "./access";
import { claimLead, loadPlan, logOutcome, releaseClaims } from "./desk-server";
import { checkCallingHours, type CallRulesConfig } from "./rules";
import { QUEUE_KINDS, type CallOutcome, type ItemKind, type QueueKind, type Touch } from "./stages";
import { dayInTz } from "./time";
import {
  decodeClientState,
  encodeClientState,
  telnyx as realTelnyx,
  telnyxConfigured,
  TelnyxError,
  toE164,
  type TelnyxClient,
} from "./telnyx";

type Deps = { telnyx: TelnyxClient; now: () => Date };
const deps: Deps = { telnyx: realTelnyx, now: () => new Date() };
/** Tests swap the Telnyx client and clock. */
export function setDialerDeps(d: Partial<Deps>): () => void {
  const prev = { ...deps };
  Object.assign(deps, d);
  return () => Object.assign(deps, prev);
}

export const SESSION_HEADER = "X-RevOS-Session";
/** A desk that stops polling for this long is treated as gone. */
const HEARTBEAT_MS = 75_000;
const OPEN = ["connecting", "ready", "dialing", "connected", "wrapup", "paused"];
const LIVE_CALL = ["queued", "dialing", "answered", "bridged"];

export class DialerError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export async function getSetup() {
  const s = await prisma.callCenterSettings.findUnique({ where: { id: "default" } });
  return {
    configured: telnyxConfigured() && !!s?.telnyxCallControlAppId && !!s?.telnyxCredentialConnectionId,
    apiKey: telnyxConfigured(),
    webhookKey: !!process.env.TELNYX_PUBLIC_KEY,
    callControlAppId: s?.telnyxCallControlAppId ?? null,
    credentialConnectionId: s?.telnyxCredentialConnectionId ?? null,
    outboundVoiceProfileId: s?.telnyxOutboundVoiceProfileId ?? null,
    webhookUrl: s?.webhookUrl ?? null,
  };
}

async function clinicNumber(clinicId: string): Promise<string | null> {
  const n = await prisma.clinicPhoneNumber.findFirst({
    where: { clinicId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: { e164: true },
  });
  return n?.e164 ?? null;
}

async function callsInLast24h(leadId: string, now: Date): Promise<number> {
  return prisma.leadCall.count({
    where: { leadId, direction: "outbound", startedAt: { gte: new Date(now.getTime() - 86400_000) } },
  });
}

// ─────────────────────────────────────────────────────────────── sessions

export async function openSession(userId: string) {
  return prisma.dialerSession.findFirst({
    where: { userId, status: { in: OPEN } },
    orderBy: { startedAt: "desc" },
  });
}

/** Start an agent's session (ends any other open one). The browser then places the parked call. */
export async function startSession(input: { clinicId: string; userId: string; mode: "manual" | "auto" }) {
  const setup = await getSetup();
  if (!setup.configured) throw new DialerError("Phone setup isn't finished yet. A super admin can finish it on Call center → Phone setup.", 409);
  const from = await clinicNumber(input.clinicId);
  if (!from) throw new DialerError("This clinic has no Telnyx number yet. Add one on Call center → Phone setup.", 409);
  const others = await prisma.dialerSession.findMany({ where: { userId: input.userId, status: { in: OPEN } }, select: { id: true } });
  for (const o of others) await endSession(o.id, "Replaced by a new session");
  const session = await prisma.dialerSession.create({
    data: { clinicId: input.clinicId, userId: input.userId, mode: input.mode, status: "connecting" },
  });
  // The browser "calls" the clinic's own number; call parking means it never
  // actually goes out — Telnyx hands it to our webhook instead.
  return { session, dialTarget: from };
}

export async function endSession(sessionId: string, reason?: string) {
  const s = await prisma.dialerSession.findUnique({ where: { id: sessionId } });
  if (!s || s.status === "ended") return;
  await prisma.dialerSession.update({
    where: { id: s.id },
    data: { status: "ended", endedAt: deps.now(), lastError: reason ?? null },
  });
  if (s.currentCallId) {
    const c = await prisma.leadCall.findUnique({ where: { id: s.currentCallId } });
    // Never leave an unanswered lead ringing with no agent behind it.
    if (c?.telnyxCallControlId && LIVE_CALL.includes(c.status)) {
      await deps.telnyx.hangup(c.telnyxCallControlId).catch(() => {});
    }
  }
  if (s.agentCallControlId) await deps.telnyx.hangup(s.agentCallControlId).catch(() => {});
  await releaseClaims(s.userId);
}

export async function setMode(userId: string, mode: "manual" | "auto") {
  const s = await openSession(userId);
  if (!s) throw new DialerError("Go live first.", 409);
  const status = s.status === "paused" ? "ready" : s.status;
  await prisma.dialerSession.update({ where: { id: s.id }, data: { mode, status, lastError: null } });
  if (mode === "auto") await autoDialNext(s.id);
}

export async function pauseAuto(userId: string) {
  const s = await openSession(userId);
  if (!s) return;
  // Finish the call in progress; just don't start another.
  await prisma.dialerSession.update({ where: { id: s.id }, data: { mode: "manual" } });
}

/** Polled by the desk every second or two. Also the heartbeat and stuck-state recovery. */
export async function sessionState(userId: string) {
  const now = deps.now();
  const s = await openSession(userId);
  if (!s) return null;
  if (s.status === "connecting" && now.getTime() - s.startedAt.getTime() > 45_000) {
    await endSession(s.id, "The browser phone didn't connect. Check the microphone permission and try again.");
    return { ...s, status: "ended", lastError: "The browser phone didn't connect. Check the microphone permission and try again.", call: null };
  }
  let call = s.currentCallId ? await prisma.leadCall.findUnique({ where: { id: s.currentCallId } }) : null;
  if (call && call.status === "dialing") {
    const rules = await loadRules(s.clinicId);
    if (now.getTime() - call.startedAt.getTime() > (rules.ringSeconds + 30) * 1000) {
      // We never heard back from Telnyx about this call: free the desk.
      await prisma.leadCall.updateMany({
        where: { id: call.id, status: "dialing" },
        data: { status: "failed", error: "No answer from the phone network", endedAt: now },
      });
      await prisma.dialerSession.updateMany({ where: { id: s.id, currentCallId: call.id }, data: { status: "ready", currentCallId: null } });
      call = await prisma.leadCall.findUnique({ where: { id: call.id } });
      if (s.mode === "auto") await autoDialNext(s.id);
    }
  }
  // Heartbeat: the auto dialer only keeps dialing for a desk that's still polling.
  const fresh = await prisma.dialerSession.update({ where: { id: s.id }, data: { updatedAt: now } });
  return { ...fresh, call };
}

// ─────────────────────────────────────────────────────────────── dialing

type Guard = { ok: true } | { ok: false; reason: string };

async function dialGuard(lead: { id: string; stage: string; consentAt: Date | null }, rules: CallRulesConfig, now: Date, auto: boolean): Promise<Guard> {
  const hours = checkCallingHours(now, rules);
  if (!hours.ok) return hours;
  if (lead.stage === "dnc") return { ok: false, reason: "This person asked not to be called." };
  if (auto && (lead.stage === "dnq" || lead.stage === "lost" || lead.stage === "showed" || lead.stage === "handed")) {
    return { ok: false, reason: "Not on the call list." };
  }
  if (auto && rules.autoDialConsentOnly && !lead.consentAt) {
    return { ok: false, reason: "No written consent on file for auto-dial." };
  }
  const n = await callsInLast24h(lead.id, now);
  if (n >= rules.maxCallsPer24h) {
    return { ok: false, reason: `Already called ${n} times in the last 24 hours (limit ${rules.maxCallsPer24h}).` };
  }
  return { ok: true };
}

async function placeCall(input: {
  sessionId: string;
  clinicId: string;
  userId: string;
  leadId: string;
  phone: string;
  mode: "manual" | "auto";
  kind: ItemKind;
  touch?: Touch | null;
  dialNumber: number;
  rules: CallRulesConfig;
}) {
  const setup = await getSetup();
  if (!setup.configured || !setup.callControlAppId) throw new DialerError("Phone setup isn't finished yet.", 409);
  const from = await clinicNumber(input.clinicId);
  if (!from) throw new DialerError("This clinic has no Telnyx number yet.", 409);
  const clinic = await prisma.clinic.findUnique({ where: { id: input.clinicId }, select: { name: true } });
  const amd = input.mode === "auto" && input.rules.skipVoicemail;
  const call = await prisma.leadCall.create({
    data: {
      clinicId: input.clinicId,
      leadId: input.leadId,
      userId: input.userId,
      sessionId: input.sessionId,
      direction: "outbound",
      mode: input.mode,
      dialNumber: input.dialNumber,
      kind: input.kind,
      touch: input.touch ?? null,
      status: "dialing",
      fromNumber: from,
      toNumber: toE164(input.phone),
      amdResult: amd ? "pending" : null,
    },
  });
  await prisma.dialerSession.update({
    where: { id: input.sessionId },
    data: { status: "dialing", currentCallId: call.id, currentLeadId: input.leadId, lastError: null },
  });
  try {
    const r = await deps.telnyx.dial({
      connectionId: setup.callControlAppId,
      to: toE164(input.phone),
      from,
      fromDisplayName: clinic?.name,
      timeoutSecs: input.rules.ringSeconds,
      clientState: encodeClientState({ t: "lead", c: call.id, s: input.sessionId }),
      answeringMachineDetection: amd ? "premium" : "disabled",
      commandId: call.id,
    });
    await prisma.leadCall.update({
      where: { id: call.id },
      data: { telnyxCallControlId: r.call_control_id, telnyxCallLegId: r.call_leg_id, telnyxCallSessionId: r.call_session_id },
    });
    return call.id;
  } catch (e) {
    const msg = e instanceof TelnyxError ? e.message : "The call couldn't be placed.";
    await prisma.leadCall.update({ where: { id: call.id }, data: { status: "failed", error: msg.slice(0, 300), endedAt: deps.now() } });
    await prisma.dialerSession.update({
      where: { id: input.sessionId },
      data: { status: "ready", currentCallId: null, lastError: msg.slice(0, 300) },
    });
    throw new DialerError(msg, 502);
  }
}

/** Click-to-call from the desk. */
export async function manualDial(input: { clinicId: string; userId: string; leadId: string; kind: ItemKind; touch?: Touch | null; redial?: boolean }) {
  const now = deps.now();
  const s = await openSession(input.userId);
  if (!s || s.clinicId !== input.clinicId) throw new DialerError("Go live on this clinic first.", 409);
  if (s.status === "wrapup") throw new DialerError("Log the result of the last call first.", 409);
  if (s.status !== "ready" && s.status !== "paused") throw new DialerError("You're already on a call.", 409);
  const lead = await prisma.lead.findFirst({
    where: { id: input.leadId, clinicId: input.clinicId },
    select: { id: true, phone: true, stage: true, consentAt: true },
  });
  if (!lead) throw new DialerError("Lead not found", 404);
  const rules = await loadRules(input.clinicId);
  const guard = await dialGuard(lead, rules, now, false);
  if (!guard.ok) throw new DialerError(guard.reason, 409);
  if (!(await claimLead(lead.id, input.userId, now))) throw new DialerError("Someone else is calling this person right now.", 409);
  return placeCall({
    sessionId: s.id,
    clinicId: input.clinicId,
    userId: input.userId,
    leadId: lead.id,
    phone: lead.phone,
    mode: "manual",
    kind: input.kind,
    touch: input.touch,
    dialNumber: input.redial ? 2 : 1,
    rules,
  });
}

export async function hangupCurrent(userId: string) {
  const s = await openSession(userId);
  if (!s?.currentCallId) return;
  const c = await prisma.leadCall.findUnique({ where: { id: s.currentCallId } });
  if (c?.telnyxCallControlId && LIVE_CALL.includes(c.status)) {
    await deps.telnyx.hangup(c.telnyxCallControlId).catch(() => {});
  }
}

/** After the agent logs a result for the session's call: free the line, and keep going in auto mode. */
export async function afterOutcome(userId: string, callId: string | null) {
  const s = await openSession(userId);
  if (!s) return;
  if (callId && s.currentCallId && s.currentCallId !== callId) return;
  const r = await prisma.dialerSession.updateMany({
    where: { id: s.id, status: { in: ["wrapup", "ready", "paused"] } },
    data: { status: "ready", currentCallId: null, currentLeadId: null },
  });
  if (r.count && s.mode === "auto") await autoDialNext(s.id);
}

/** Auto mode: dial the next lead in list order that passes every guard. */
export async function autoDialNext(sessionId: string): Promise<void> {
  const now = deps.now();
  const s = await prisma.dialerSession.findUnique({ where: { id: sessionId } });
  if (!s || s.mode !== "auto" || s.status !== "ready" || !s.agentCallControlId) return;
  if (now.getTime() - s.updatedAt.getTime() > HEARTBEAT_MS) {
    await prisma.dialerSession.update({ where: { id: s.id }, data: { status: "paused", lastError: "Auto-dial paused: the desk stopped responding." } });
    return;
  }
  const rules = await loadRules(s.clinicId);
  const hours = checkCallingHours(now, rules);
  if (!hours.ok) {
    await prisma.dialerSession.update({ where: { id: s.id }, data: { mode: "manual", lastError: `Auto-dial stopped. ${hours.reason}` } });
    return;
  }
  // Take the dialing slot first so concurrent triggers can't double-dial.
  const slot = await prisma.dialerSession.updateMany({ where: { id: s.id, status: "ready", mode: "auto" }, data: { status: "dialing" } });
  if (!slot.count) return;

  const { plan } = await loadPlan(s.clinicId, s.userId, now);
  // Confirmation calls stay with the agent (a voicemail is fine there), and a
  // call-back waits for the time the person asked for.
  const items = plan.sections
    .flatMap((sec) => sec.items)
    .filter((i) => !i.done && !i.claimedByOther && i.kind !== "confirm");
  const leads = await prisma.lead.findMany({
    where: { id: { in: items.map((i) => i.leadId) }, clinicId: s.clinicId },
    select: { id: true, phone: true, stage: true, consentAt: true, callbackAt: true },
  });
  const byId = new Map(leads.map((l) => [l.id, l]));
  let skippedConsent = 0;
  for (const it of items) {
    const lead = byId.get(it.leadId);
    if (!lead) continue;
    if (it.kind === "callback" && lead.callbackAt && lead.callbackAt.getTime() > now.getTime() + 5 * 60_000) continue;
    const g = await dialGuard(lead, rules, now, true);
    if (!g.ok) {
      if (g.reason.startsWith("No written consent")) skippedConsent++;
      continue;
    }
    if (!(await claimLead(lead.id, s.userId, now))) continue;
    try {
      await placeCall({
        sessionId: s.id,
        clinicId: s.clinicId,
        userId: s.userId,
        leadId: lead.id,
        phone: lead.phone,
        mode: "auto",
        kind: it.kind,
        touch: it.touch,
        dialNumber: 1,
        rules,
      });
    } catch {
      // placeCall already freed the slot and recorded the error.
      await prisma.dialerSession.update({ where: { id: s.id }, data: { mode: "manual" } });
    }
    return;
  }
  await prisma.dialerSession.update({
    where: { id: s.id },
    data: {
      status: "ready",
      mode: "manual",
      lastError: skippedConsent
        ? `Auto-dial finished. ${skippedConsent} more on today's list have no written consent on file, so call them one at a time.`
        : "Auto-dial finished: nobody else on today's list can be called right now.",
    },
  });
}

// ─────────────────────────────────────────────────────────────── webhooks

type Payload = {
  call_control_id?: string;
  call_leg_id?: string;
  call_session_id?: string;
  connection_id?: string;
  client_state?: string;
  direction?: string;
  state?: string;
  from?: string;
  to?: string;
  hangup_cause?: string;
  result?: string;
  custom_headers?: { name?: string; value?: string }[];
};

export async function handleTelnyxEvent(event: { event_type?: string; payload?: Payload }) {
  const p = event.payload ?? {};
  const st = decodeClientState(p.client_state);
  switch (event.event_type) {
    case "call.initiated":
      return onInitiated(p, st);
    case "call.answered":
      return onAnswered(p, st);
    case "call.bridged":
      return onBridged(p, st);
    case "call.machine.premium.detection.ended":
    case "call.machine.detection.ended":
      return onMachine(p, st);
    case "call.speak.ended":
      if (st?.t === "missed" && p.call_control_id) await deps.telnyx.hangup(p.call_control_id).catch(() => {});
      return;
    case "call.hangup":
      return onHangup(p, st);
    default:
      return;
  }
}

function header(p: Payload, name: string): string | null {
  const h = (p.custom_headers ?? []).find((x) => (x.name || "").toLowerCase() === name.toLowerCase());
  return h?.value ?? null;
}

async function onInitiated(p: Payload, st: Record<string, unknown> | null) {
  if (!p.call_control_id) return;
  if (st?.t === "lead") {
    const call = await prisma.leadCall.findUnique({ where: { id: String(st.c) } });
    if (!call) return;
    if (!call.telnyxCallControlId) {
      await prisma.leadCall.updateMany({
        where: { id: call.id, telnyxCallControlId: null },
        data: { telnyxCallControlId: p.call_control_id, telnyxCallLegId: p.call_leg_id, telnyxCallSessionId: p.call_session_id },
      });
    }
    if (call.mode === "manual") {
      const s = call.sessionId ? await prisma.dialerSession.findUnique({ where: { id: call.sessionId } }) : null;
      if (s?.agentCallControlId) {
        // The agent hears it ring, then the person: just like dialing themselves.
        await deps.telnyx
          .bridge(s.agentCallControlId, p.call_control_id, { playRingtone: true, parkAfterUnbridge: true, commandId: `bridge-${call.id}` })
          .catch(async (e) => {
            await prisma.leadCall.update({ where: { id: call.id }, data: { error: String(e?.message ?? e).slice(0, 300) } });
            await deps.telnyx.hangup(p.call_control_id!).catch(() => {});
          });
      }
    }
    return;
  }

  const setup = await getSetup();
  // A browser phone going live: its call is parked on the credential connection.
  if (p.connection_id && p.connection_id === setup.credentialConnectionId) {
    const sessionId = header(p, SESSION_HEADER);
    const s = sessionId ? await prisma.dialerSession.findUnique({ where: { id: sessionId } }) : null;
    if (!s || s.status !== "connecting" || s.agentCallControlId) {
      await deps.telnyx.hangup(p.call_control_id).catch(() => {});
      return;
    }
    const user = await prisma.user.findUnique({ where: { id: s.userId }, select: { telnyxSipUsername: true } });
    // The SIP From is the credential's username; refuse a session id sent from someone else's phone.
    if (user?.telnyxSipUsername && p.from && /gencred/i.test(p.from) && !p.from.toLowerCase().includes(user.telnyxSipUsername.toLowerCase())) {
      await deps.telnyx.hangup(p.call_control_id).catch(() => {});
      return;
    }
    const claimed = await prisma.dialerSession.updateMany({
      where: { id: s.id, status: "connecting", agentCallControlId: null },
      data: { agentCallControlId: p.call_control_id },
    });
    if (!claimed.count) return;
    await deps.telnyx.answer(p.call_control_id, { clientState: encodeClientState({ t: "agent", s: s.id }) });
    await prisma.dialerSession.updateMany({ where: { id: s.id, status: "connecting" }, data: { status: "ready" } });
    if (s.mode === "auto") await autoDialNext(s.id);
    return;
  }

  // A patient calling one of our numbers.
  if (p.direction === "incoming" && p.connection_id && p.connection_id === setup.callControlAppId) {
    await onInbound(p);
  }
}

async function onInbound(p: Payload) {
  const now = deps.now();
  const number = p.to ? await prisma.clinicPhoneNumber.findUnique({ where: { e164: p.to } }) : null;
  if (!number) {
    await deps.telnyx.hangup(p.call_control_id!).catch(() => {});
    return;
  }
  const clinicId = number.clinicId;
  const phone = normalizePhone(p.from);
  let lead = phone && phone.length === 10 ? await prisma.lead.findUnique({ where: { clinicId_phone: { clinicId, phone } } }) : null;
  if (!lead && phone && phone.length === 10) {
    lead = await prisma.lead.create({ data: { clinicId, phone, source: "inbound", stage: "new" } });
  }
  const call = await prisma.leadCall.create({
    data: {
      clinicId,
      leadId: lead?.id ?? null,
      direction: "inbound",
      mode: "manual",
      status: "answered",
      fromNumber: p.from ?? null,
      toNumber: p.to ?? "",
      telnyxCallControlId: p.call_control_id,
      telnyxCallLegId: p.call_leg_id,
      telnyxCallSessionId: p.call_session_id,
      kind: "inbound",
      answeredAt: now,
    },
  });
  // First free agent on this clinic whose desk is alive.
  const candidates = await prisma.dialerSession.findMany({
    where: { clinicId, status: "ready", agentCallControlId: { not: null }, updatedAt: { gte: new Date(now.getTime() - HEARTBEAT_MS) } },
    orderBy: { updatedAt: "desc" },
  });
  for (const s of candidates) {
    const took = await prisma.dialerSession.updateMany({
      where: { id: s.id, status: "ready" },
      data: { status: "connected", currentCallId: call.id, currentLeadId: lead?.id ?? null },
    });
    if (!took.count) continue;
    await prisma.leadCall.update({ where: { id: call.id }, data: { sessionId: s.id, userId: s.userId } });
    await deps.telnyx.answer(p.call_control_id!, { clientState: encodeClientState({ t: "inbound", c: call.id, s: s.id }) });
    await deps.telnyx.bridge(s.agentCallControlId!, p.call_control_id!, { parkAfterUnbridge: true, commandId: `bridge-${call.id}` });
    return;
  }
  // Nobody free: a short message, then it's a callback at the top of the list.
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { name: true } });
  await deps.telnyx.answer(p.call_control_id!, { clientState: encodeClientState({ t: "missed", c: call.id }) });
  await deps.telnyx
    .speak(
      p.call_control_id!,
      `Thanks for calling ${clinic?.name ?? "us"}. We're with other patients right now, and we'll call you back shortly. Goodbye.`,
      { clientState: encodeClientState({ t: "missed", c: call.id }) },
    )
    .catch(() => deps.telnyx.hangup(p.call_control_id!).catch(() => {}));
  if (lead) {
    const rules = await loadRules(clinicId);
    const day = dayInTz(now, rules.timezone);
    const keepStage = ["booked", "showed", "dnc", "dnq"].includes(lead.stage);
    await prisma.$transaction([
      prisma.leadActivity.create({ data: { leadId: lead.id, clinicId, day, kind: "inbound", outcome: "missed", at: now, callId: call.id } }),
      ...(keepStage
        ? []
        : [prisma.lead.update({ where: { id: lead.id }, data: { stage: "nurture", callbackAt: now, nextDueDay: day, lostReason: null } })]),
    ]);
  }
}

async function onAnswered(p: Payload, st: Record<string, unknown> | null) {
  if (st?.t === "agent") {
    await prisma.dialerSession.updateMany({ where: { id: String(st.s), status: "connecting" }, data: { status: "ready" } });
    return;
  }
  if (st?.t !== "lead") return;
  const now = deps.now();
  const call = await prisma.leadCall.findUnique({ where: { id: String(st.c) } });
  if (!call) return;
  await prisma.leadCall.updateMany({ where: { id: call.id, status: "dialing" }, data: { status: "answered", answeredAt: now } });
  if (call.mode === "auto" && call.amdResult !== "pending") await connectToAgent(call.id, p.call_control_id!);
}

/** Auto mode: put an answered lead through to the agent's line, once. */
async function connectToAgent(callId: string, leadLeg: string) {
  const call = await prisma.leadCall.findUnique({ where: { id: callId } });
  if (!call?.sessionId) return;
  const s = await prisma.dialerSession.findUnique({ where: { id: call.sessionId } });
  if (!s?.agentCallControlId || s.status === "ended") {
    // No agent behind this call any more: don't leave the person on silence.
    await deps.telnyx.hangup(leadLeg).catch(() => {});
    return;
  }
  const once = await prisma.leadCall.updateMany({ where: { id: callId, bridgedAt: null, status: { in: ["answered", "dialing"] } }, data: { status: "answered" } });
  if (!once.count) return;
  await deps.telnyx
    .bridge(s.agentCallControlId, leadLeg, { parkAfterUnbridge: true, commandId: `bridge-${callId}` })
    .catch(async (e) => {
      await prisma.leadCall.update({ where: { id: callId }, data: { error: String(e?.message ?? e).slice(0, 300) } });
      await deps.telnyx.hangup(leadLeg).catch(() => {});
    });
}

async function onMachine(p: Payload, st: Record<string, unknown> | null) {
  if (st?.t !== "lead" || !p.call_control_id) return;
  const result = p.result ?? "not_sure";
  const call = await prisma.leadCall.findUnique({ where: { id: String(st.c) } });
  if (!call || call.amdResult !== "pending") return;
  await prisma.leadCall.update({ where: { id: call.id }, data: { amdResult: result } });
  const machine = result === "machine" || result === "silence" || result === "fax_detected";
  if (machine) {
    // Protocol: no voicemails. Hang up; the hangup handler logs it.
    await deps.telnyx.hangup(p.call_control_id).catch(() => {});
  } else {
    await connectToAgent(call.id, p.call_control_id);
  }
}

async function onBridged(p: Payload, st: Record<string, unknown> | null) {
  if (st?.t !== "lead" && st?.t !== "inbound") return;
  const now = deps.now();
  const call = await prisma.leadCall.findUnique({ where: { id: String(st.c) } });
  if (!call) return;
  await prisma.leadCall.updateMany({
    where: { id: call.id, bridgedAt: null },
    data: { status: "bridged", bridgedAt: now, answeredAt: call.answeredAt ?? now },
  });
  if (call.sessionId) {
    await prisma.dialerSession.updateMany({ where: { id: call.sessionId, currentCallId: call.id }, data: { status: "connected" } });
  }
}

async function onHangup(p: Payload, st: Record<string, unknown> | null) {
  const now = deps.now();
  if (st?.t === "agent") {
    const s = await prisma.dialerSession.findUnique({ where: { id: String(st.s) } });
    if (s && s.status !== "ended") await endSession(s.id, "The browser phone hung up.");
    return;
  }
  if (st?.t === "missed") {
    await prisma.leadCall.updateMany({ where: { id: String(st.c), endedAt: null }, data: { status: "ended", endedAt: now, hangupCause: p.hangup_cause ?? null } });
    return;
  }
  if (st?.t !== "lead" && st?.t !== "inbound") {
    // A browser phone we refused, or a stray leg: if it was someone's agent leg, end that session.
    if (p.call_control_id) {
      const s = await prisma.dialerSession.findUnique({ where: { agentCallControlId: p.call_control_id } });
      if (s && s.status !== "ended") await endSession(s.id, "The browser phone hung up.");
    }
    return;
  }
  const call = await prisma.leadCall.findUnique({ where: { id: String(st.c) } });
  if (!call) return;
  const done = await prisma.leadCall.updateMany({
    where: { id: call.id, status: { in: LIVE_CALL } },
    data: { status: "ended", endedAt: now, hangupCause: p.hangup_cause ?? null },
  });
  if (!done.count) return; // already handled (retried webhook)
  if (!call.sessionId) return;
  const s = await prisma.dialerSession.findUnique({ where: { id: call.sessionId } });
  if (!s || s.status === "ended" || s.currentCallId !== call.id) return;

  if (call.bridgedAt || (await prisma.leadCall.findUnique({ where: { id: call.id }, select: { bridgedAt: true } }))?.bridgedAt) {
    // They talked: the agent logs what happened.
    await prisma.dialerSession.update({ where: { id: s.id }, data: { status: "wrapup" } });
    return;
  }
  if (call.mode === "manual" || call.direction === "inbound") {
    // Manual: the agent picks No answer / voicemail themselves, as on the Dial Desk.
    await prisma.dialerSession.update({ where: { id: s.id }, data: { status: "wrapup" } });
    return;
  }

  // Auto, never connected: log it and move on.
  const machine = ["machine", "silence", "fax_detected"].includes(call.amdResult ?? "");
  const outcome: CallOutcome = machine ? "vm" : "na";
  const kind = (QUEUE_KINDS as readonly string[]).includes(call.kind ?? "") ? (call.kind as QueueKind) : "fresh";
  const rules = await loadRules(s.clinicId);
  const lead = call.leadId ? await prisma.lead.findUnique({ where: { id: call.leadId }, select: { id: true, phone: true, stage: true, consentAt: true } }) : null;

  if (lead && call.dialNumber === 1 && rules.doubleDial && s.mode === "auto") {
    const g = await dialGuard(lead, rules, now, true);
    if (g.ok) {
      // First dial unanswered: the immediate second dial (logged as one try).
      await prisma.dialerSession.update({ where: { id: s.id }, data: { status: "ready" } });
      const slot = await prisma.dialerSession.updateMany({ where: { id: s.id, status: "ready" }, data: { status: "dialing" } });
      if (slot.count) {
        try {
          await placeCall({ sessionId: s.id, clinicId: s.clinicId, userId: s.userId, leadId: lead.id, phone: lead.phone, mode: "auto", kind, touch: (call.touch as Touch) ?? null, dialNumber: 2, rules });
          return;
        } catch {
          /* fall through and log the first dial */
        }
      }
    }
  }
  if (lead) {
    await logOutcome({
      clinicId: s.clinicId,
      userId: s.userId,
      leadId: lead.id,
      kind,
      touch: null,
      outcome,
      // The second dial (or a single dial with double-dial off) finishes the try.
      redial: true,
      callId: call.id,
      now,
    }).catch(() => {});
  }
  await releaseClaims(s.userId, call.leadId ?? undefined);
  await prisma.dialerSession.updateMany({ where: { id: s.id, currentCallId: call.id }, data: { status: "ready", currentCallId: null, currentLeadId: null } });
  await autoDialNext(s.id);
}
