/**
 * Server side of the desk: load a clinic's day, write call results.
 *
 * Every write goes through the pure functions in outcomes.ts and is recorded as
 * LeadActivity rows (notes encrypted), which is also what the day's list and
 * the report are rebuilt from.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { decryptField, encryptField } from "../encryption";
import { normalizePhone } from "../phone";
import { loadRules } from "./access";
import { applyMark, applyOutcome, applyStage, mmdd, type ActivityDraft, type LeadPatch } from "./outcomes";
import { buildDayPlan, dayStats, weekMarks, type DayActivity, type DayPlan, type QueueLead } from "./queue";
import type { CallRulesConfig } from "./rules";
import { isStage, leadName, type CallOutcome, type ItemKind, type Mark, type Touch } from "./stages";
import { addDays, dayInTz, weekDays, zonedTimeToUtc, type Day } from "./time";

const CLAIM_MS = 3 * 60_000;

export const QUEUE_SELECT = {
  id: true,
  stage: true,
  priority: true,
  attempts: true,
  lastAttemptDay: true,
  nextDueDay: true,
  callbackAt: true,
  apptAt: true,
  confirm48Day: true,
  confirm24Day: true,
  confirmDayOfDay: true,
  confirmedAt: true,
  skippedAt: true,
  createdAt: true,
  claimedById: true,
  claimedUntil: true,
} satisfies Prisma.LeadSelect;

const SUMMARY_SELECT = {
  ...QUEUE_SELECT,
  firstName: true,
  lastName: true,
  phone: true,
  lastCalledAt: true,
} satisfies Prisma.LeadSelect;

export type LeadSummary = {
  id: string;
  name: string;
  phone: string;
  stage: string;
  priority: boolean;
  attempts: number;
  callbackAt: string | null;
  apptAt: string | null;
  lastCalledAt: string | null;
  lastAttemptDay: string | null;
};

function summarize(l: Prisma.LeadGetPayload<{ select: typeof SUMMARY_SELECT }>): LeadSummary {
  return {
    id: l.id,
    name: leadName(l),
    phone: l.phone,
    stage: l.stage,
    priority: l.priority,
    attempts: l.attempts,
    callbackAt: l.callbackAt?.toISOString() ?? null,
    apptAt: l.apptAt?.toISOString() ?? null,
    lastCalledAt: l.lastCalledAt?.toISOString() ?? null,
    lastAttemptDay: l.lastAttemptDay,
  };
}

/** "Unable to contact" leads go back to new after `recycleDays` (0 = never). */
async function recycleIfDue(clinicId: string, rules: CallRulesConfig, now: Date, day: Day) {
  if (!rules.recycleDays) return;
  const cutoff = new Date(now.getTime() - rules.recycleDays * 86400_000);
  const due = await prisma.lead.findMany({
    where: { clinicId, stage: "lost", lostReason: "Unable to contact", lastCalledAt: { lte: cutoff } },
    select: { id: true },
    take: 1000,
  });
  if (!due.length) return;
  const ids = due.map((d) => d.id);
  await prisma.$transaction([
    prisma.lead.updateMany({
      where: { id: { in: ids }, stage: "lost" },
      data: { stage: "new", attempts: 0, nextDueDay: null, lostReason: null },
    }),
    prisma.leadActivity.createMany({
      data: ids.map((leadId) => ({ leadId, clinicId, day, kind: "mark", outcome: "recycle", at: now })),
    }),
  ]);
}

export async function loadPlan(clinicId: string, userId: string | null, now: Date) {
  const rules = await loadRules(clinicId);
  const day = dayInTz(now, rules.timezone);
  await recycleIfDue(clinicId, rules, now, day);
  const callDay = await prisma.callDay.findUnique({ where: { clinicId_day: { clinicId, day } } });
  const extraFresh = callDay?.extraFresh ?? 0;
  const [active, fresh, activities, newLeft] = await Promise.all([
    prisma.lead.findMany({
      where: { clinicId, stage: { in: ["cycle", "nurture", "booked", "resched"] } },
      select: QUEUE_SELECT,
    }),
    prisma.lead.findMany({
      where: { clinicId, stage: "new" },
      select: QUEUE_SELECT,
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      take: rules.dailyTarget + extraFresh + 50,
    }),
    prisma.leadActivity.findMany({
      where: { clinicId, day },
      select: { leadId: true, kind: true, outcome: true, touch: true, at: true },
    }),
    prisma.lead.count({ where: { clinicId, stage: "new" } }),
  ]);
  const leads: QueueLead[] = [...active, ...fresh];
  const plan = buildDayPlan({ leads, activities, rules, day, now, extraFresh, userId });
  return { rules, day, plan, activities: activities as DayActivity[], newLeft, leads };
}

/** Claim a lead for this agent for a few minutes. False if someone else has it. */
export async function claimLead(leadId: string, userId: string, now: Date): Promise<boolean> {
  const r = await prisma.lead.updateMany({
    where: {
      id: leadId,
      OR: [{ claimedById: null }, { claimedById: userId }, { claimedUntil: { lt: now } }],
    },
    data: { claimedById: userId, claimedUntil: new Date(now.getTime() + CLAIM_MS) },
  });
  return r.count === 1;
}

export async function releaseClaims(userId: string, leadId?: string) {
  await prisma.lead.updateMany({
    where: { claimedById: userId, ...(leadId ? { id: leadId } : {}) },
    data: { claimedById: null, claimedUntil: null },
  });
}

export type HistoryEntry = {
  at: string;
  kind: string;
  outcome: string;
  touch: string | null;
  scheduledAt: string | null;
  note: string | null;
};

export async function leadDetail(clinicId: string, leadId: string, now: Date) {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, clinicId },
    include: {
      activities: { orderBy: { at: "desc" }, take: 30 },
      customer: { select: { id: true, firstName: true, lastName: true } },
    },
  });
  if (!lead) return null;
  const callsLast24h = await prisma.leadCall.count({
    where: { leadId, direction: "outbound", startedAt: { gte: new Date(now.getTime() - 86400_000) } },
  });
  const history: HistoryEntry[] = lead.activities.map((a) => ({
    at: a.at.toISOString(),
    kind: a.kind,
    outcome: a.outcome,
    touch: a.touch,
    scheduledAt: a.scheduledAt?.toISOString() ?? null,
    note: decryptField(a.note),
  }));
  return {
    id: lead.id,
    name: leadName(lead),
    firstName: lead.firstName,
    lastName: lead.lastName,
    phone: lead.phone,
    email: lead.email,
    stage: lead.stage,
    priority: lead.priority,
    lostReason: lead.lostReason,
    attempts: lead.attempts,
    dials: lead.dials,
    lastCalledAt: lead.lastCalledAt?.toISOString() ?? null,
    lastAttemptDay: lead.lastAttemptDay,
    nextDueDay: lead.nextDueDay,
    callbackAt: lead.callbackAt?.toISOString() ?? null,
    apptAt: lead.apptAt?.toISOString() ?? null,
    confirmedAt: lead.confirmedAt?.toISOString() ?? null,
    needsTextDay: lead.needsTextDay,
    lastNote: decryptField(lead.lastNote),
    consent: !!lead.consentAt,
    consentSource: lead.consentSource,
    source: lead.source,
    leadSource: lead.leadSource,
    sourceStatus: lead.sourceStatus,
    customer: lead.customer ? { id: lead.customer.id, name: leadName(lead.customer) } : null,
    callsLast24h,
    history,
  };
}
export type LeadDetail = NonNullable<Awaited<ReturnType<typeof leadDetail>>>;

/** Everything the Today screen needs, in one round trip. */
export async function buildDesk(input: {
  clinicId: string;
  userId: string;
  now: Date;
  focusLeadId?: string | null;
  focusKind?: "inbound" | null;
}) {
  const { clinicId, userId, now } = input;
  const { rules, day, plan, activities, newLeft } = await loadPlan(clinicId, userId, now);

  // Current card: an opened/pinned lead, else the first open item we can claim.
  let current: { leadId: string; kind: ItemKind; touch?: Touch } | null = null;
  if (input.focusLeadId) {
    const inPlan = plan.sections.flatMap((s) => s.items).find((i) => i.leadId === input.focusLeadId && !i.done);
    current =
      input.focusKind === "inbound"
        ? { leadId: input.focusLeadId, kind: "inbound" }
        : inPlan
          ? { leadId: inPlan.leadId, kind: inPlan.kind, touch: inPlan.touch }
          : { leadId: input.focusLeadId, kind: "manual" };
  } else {
    for (const s of plan.sections) {
      for (const it of s.items) {
        if (it.done || it.claimedByOther) continue;
        if (await claimLead(it.leadId, userId, now)) {
          current = { leadId: it.leadId, kind: it.kind, touch: it.touch };
          break;
        }
        it.claimedByOther = true;
      }
      if (current) break;
    }
  }

  const ids = new Set(plan.sections.flatMap((s) => s.items.map((i) => i.leadId)));
  if (current) ids.add(current.leadId);
  const rows = await prisma.lead.findMany({ where: { id: { in: [...ids] }, clinicId }, select: SUMMARY_SELECT });
  const summaries: Record<string, LeadSummary> = {};
  for (const r of rows) summaries[r.id] = summarize(r);

  const detail = current ? await leadDetail(clinicId, current.leadId, now) : null;
  if (current && !detail) current = null;

  return {
    day,
    rules,
    plan: stripPlan(plan),
    leads: summaries,
    current,
    detail,
    stats: dayStats(activities),
    newLeft,
  };
}

function stripPlan(plan: DayPlan) {
  return { ...plan, current: undefined };
}

export type OutcomeInput = {
  clinicId: string;
  userId: string;
  leadId: string;
  kind: ItemKind;
  touch?: Touch | null;
  outcome: CallOutcome;
  /** Clinic-local "YYYY-MM-DDTHH:mm" from the date picker. */
  scheduledLocal?: string | null;
  note?: string | null;
  redial?: boolean;
  callId?: string | null;
  now: Date;
};

function encPatch(patch: LeadPatch): Prisma.LeadUpdateManyMutationInput {
  const { lastNote, ...rest } = patch;
  return { ...rest, ...(lastNote !== undefined ? { lastNote: encryptField(lastNote) } : {}) };
}

function activityRows(drafts: ActivityDraft[], base: { leadId: string; clinicId: string; userId: string | null; day: Day; at: Date; callId?: string | null }) {
  return drafts.map((a, i) => ({
    leadId: base.leadId,
    clinicId: base.clinicId,
    userId: base.userId,
    day: base.day,
    // Keep extra entries (e.g. "cancelled" after "Cancelled") in order.
    at: new Date(base.at.getTime() + i),
    kind: a.kind,
    outcome: a.outcome,
    touch: a.touch ?? null,
    scheduledAt: a.scheduledAt ?? null,
    note: a.note ? encryptField(a.note) : null,
    callId: base.callId ?? null,
  }));
}

export async function logOutcome(input: OutcomeInput) {
  const rules = await loadRules(input.clinicId);
  const day = dayInTz(input.now, rules.timezone);
  const lead = await prisma.lead.findFirst({
    where: { id: input.leadId, clinicId: input.clinicId },
    select: { id: true, stage: true, attempts: true, dials: true, lastAttemptDay: true, apptAt: true },
  });
  if (!lead) return { ok: false as const, status: 404, error: "Lead not found" };
  const scheduledAt = input.scheduledLocal ? zonedTimeToUtc(input.scheduledLocal, rules.timezone) : null;
  if (input.scheduledLocal && !scheduledAt) return { ok: false as const, status: 400, error: "That date and time isn't valid." };
  const res = applyOutcome({
    lead,
    kind: input.kind,
    touch: input.touch ?? null,
    outcome: input.outcome,
    scheduledAt,
    note: input.note,
    redial: input.redial,
    day,
    now: input.now,
    rules,
  });
  if (!res.ok) return { ok: false as const, status: 400, error: res.error };

  const release = res.advance ? { claimedById: null, claimedUntil: null, skippedAt: null } : {};
  const ops: Prisma.PrismaPromise<unknown>[] = [
    prisma.lead.updateMany({ where: { id: lead.id, clinicId: input.clinicId }, data: { ...encPatch(res.patch), ...release } }),
    prisma.leadActivity.createMany({
      data: activityRows(res.activities, { leadId: lead.id, clinicId: input.clinicId, userId: input.userId, day, at: input.now, callId: input.callId }),
    }),
  ];
  if (input.callId) {
    ops.push(prisma.leadCall.updateMany({ where: { id: input.callId, clinicId: input.clinicId, leadId: lead.id }, data: { outcome: input.outcome } }));
  }
  await prisma.$transaction(ops);
  return { ok: true as const, message: res.message, advance: res.advance, redialNext: res.redialNext };
}

export type MarkInput =
  | { action: "mark"; mark: Mark }
  | { action: "stage"; stage: string }
  | { action: "priority"; priority: boolean }
  | { action: "appt"; apptLocal: string };

export async function markLead(input: { clinicId: string; userId: string; leadId: string; now: Date } & MarkInput) {
  const rules = await loadRules(input.clinicId);
  const day = dayInTz(input.now, rules.timezone);
  const lead = await prisma.lead.findFirst({ where: { id: input.leadId, clinicId: input.clinicId }, select: { id: true, stage: true } });
  if (!lead) return { ok: false as const, status: 404, error: "Lead not found" };

  let patch: LeadPatch;
  let activity: ActivityDraft;
  let message = "";
  if (input.action === "mark") {
    const r = applyMark(input.mark, day);
    patch = r.patch;
    activity = r.activity;
    message = r.message;
  } else if (input.action === "stage") {
    if (!isStage(input.stage)) return { ok: false as const, status: 400, error: "Unknown status" };
    patch = applyStage(input.stage, day);
    activity = { kind: "mark", outcome: "stage", note: null };
    message = "Status updated.";
  } else if (input.action === "priority") {
    patch = { priority: input.priority };
    activity = { kind: "mark", outcome: "priority" };
    message = input.priority ? "Marked priority." : "Priority removed.";
  } else {
    const appt = zonedTimeToUtc(input.apptLocal, rules.timezone);
    if (!appt) return { ok: false as const, status: 400, error: "That date and time isn't valid." };
    if (lead.stage !== "booked") return { ok: false as const, status: 400, error: "Only booked leads have an appointment." };
    patch = { apptAt: appt, confirm48Day: null, confirm24Day: null, confirmDayOfDay: null, confirmedAt: null };
    activity = { kind: "mark", outcome: "appt", scheduledAt: appt };
    message = "Appointment time saved.";
  }
  await prisma.$transaction([
    prisma.lead.updateMany({ where: { id: lead.id, clinicId: input.clinicId }, data: encPatch(patch) }),
    prisma.leadActivity.createMany({
      data: activityRows([activity], { leadId: lead.id, clinicId: input.clinicId, userId: input.userId, day, at: input.now }),
    }),
  ]);
  return { ok: true as const, message };
}

export async function skipLead(clinicId: string, userId: string, leadId: string, now: Date) {
  const r = await prisma.lead.updateMany({
    where: { id: leadId, clinicId },
    data: { skippedAt: now, claimedById: null, claimedUntil: null },
  });
  return r.count === 1;
}

export async function addFreshLeads(clinicId: string, now: Date, n = 25) {
  const rules = await loadRules(clinicId);
  const day = dayInTz(now, rules.timezone);
  await prisma.callDay.upsert({
    where: { clinicId_day: { clinicId, day } },
    create: { clinicId, day, extraFresh: n },
    update: { extraFresh: { increment: n } },
  });
}

export async function listLeads(input: {
  clinicId: string;
  stage?: string | null;
  q?: string | null;
  priorityOnly?: boolean;
  page?: number;
  perPage?: number;
}) {
  const perPage = Math.min(Math.max(input.perPage ?? 100, 10), 200);
  const page = Math.max(input.page ?? 0, 0);
  const where: Prisma.LeadWhereInput = { clinicId: input.clinicId };
  if (input.stage && isStage(input.stage)) where.stage = input.stage;
  if (input.priorityOnly) where.priority = true;
  const q = (input.q || "").trim();
  if (q) {
    const digits = q.replace(/\D/g, "");
    where.OR = [
      { firstName: { contains: q, mode: "insensitive" } },
      { lastName: { contains: q, mode: "insensitive" } },
      { email: { contains: q, mode: "insensitive" } },
      ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
    ];
    const parts = q.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      where.OR.push({
        AND: [
          { firstName: { contains: parts[0], mode: "insensitive" } },
          { lastName: { contains: parts.slice(1).join(" "), mode: "insensitive" } },
        ],
      });
    }
  }
  const [total, rows, counts] = await Promise.all([
    prisma.lead.count({ where }),
    prisma.lead.findMany({
      where,
      select: { ...SUMMARY_SELECT, consentAt: true, source: true },
      orderBy: [{ createdAt: "asc" }],
      skip: page * perPage,
      take: perPage,
    }),
    prisma.lead.groupBy({ by: ["stage"], where: { clinicId: input.clinicId }, _count: { _all: true } }),
  ]);
  return {
    total,
    page,
    perPage,
    rows: rows.map((r) => ({ ...summarize(r), nextDueDay: r.nextDueDay, consent: !!r.consentAt, source: r.source })),
    counts: Object.fromEntries(counts.map((c) => [c.stage, c._count._all])),
  };
}

export async function createLead(input: {
  clinicId: string;
  userId: string;
  firstName?: string | null;
  lastName?: string | null;
  phone: string;
  email?: string | null;
  note?: string | null;
  priority?: boolean;
  consent?: boolean;
  now: Date;
}) {
  const phone = normalizePhone(input.phone);
  if (!phone || phone.length !== 10) return { ok: false as const, status: 400, error: "Enter a 10-digit US phone number." };
  const existing = await prisma.lead.findUnique({ where: { clinicId_phone: { clinicId: input.clinicId, phone } }, select: { id: true } });
  if (existing) return { ok: false as const, status: 409, error: "That number is already a lead here.", leadId: existing.id };
  const rules = await loadRules(input.clinicId);
  const day = dayInTz(input.now, rules.timezone);
  const note = (input.note || "").trim();
  const customer = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Customer"
    WHERE "clinicId" = ${input.clinicId}
      AND right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = ${phone}
    LIMIT 1`;
  const lead = await prisma.lead.create({
    data: {
      clinicId: input.clinicId,
      firstName: input.firstName?.trim() || null,
      lastName: input.lastName?.trim() || null,
      phone,
      email: input.email?.trim() || null,
      priority: !!input.priority,
      source: "manual",
      lastNote: note ? encryptField(`${mmdd(day)}: ${note}`) : null,
      consentAt: input.consent ? input.now : null,
      consentSource: input.consent ? "manual" : null,
      customerId: customer[0]?.id ?? null,
    },
    select: { id: true },
  });
  return { ok: true as const, leadId: lead.id };
}

/** The Report tab: one day's tally, who was booked, and the week so far. */
export async function buildReport(clinicId: string, now: Date, dayParam?: string | null) {
  const rules = await loadRules(clinicId);
  const today = dayInTz(now, rules.timezone);
  const day = dayParam && /^\d{4}-\d{2}-\d{2}$/.test(dayParam) && dayParam <= today ? dayParam : today;
  const week = weekDays(day).filter((d) => d <= today);
  const acts = await prisma.leadActivity.findMany({
    where: { clinicId, day: { in: week } },
    select: { leadId: true, kind: true, outcome: true, touch: true, at: true, day: true, scheduledAt: true, userId: true },
    orderBy: { at: "asc" },
  });
  const byDay = new Map<string, typeof acts>();
  for (const a of acts) {
    const list = byDay.get(a.day) ?? [];
    list.push(a);
    byDay.set(a.day, list);
  }
  const todays = byDay.get(day) ?? [];
  const bookedActs = todays.filter((a) => a.outcome === "book");
  const bookedLeads = bookedActs.length
    ? await prisma.lead.findMany({
        where: { id: { in: bookedActs.map((a) => a.leadId) }, clinicId },
        select: { id: true, firstName: true, lastName: true, phone: true, apptAt: true },
      })
    : [];
  const leadById = new Map(bookedLeads.map((l) => [l.id, l]));
  // The selected day's window in clinic time (DST-safe: next local midnight).
  const dayStart = zonedTimeToUtc(`${day}T00:00`, rules.timezone)!;
  const dayEnd = zonedTimeToUtc(`${addDays(day, 1)}T00:00`, rules.timezone)!;
  const talked = await prisma.leadCall.findMany({
    where: { clinicId, startedAt: { gte: dayStart, lt: dayEnd }, bridgedAt: { not: null }, endedAt: { not: null } },
    select: { bridgedAt: true, endedAt: true },
  });
  const talkSeconds = talked.reduce((s, c) => s + Math.max(0, (c.endedAt!.getTime() - c.bridgedAt!.getTime()) / 1000), 0);
  return {
    day,
    today,
    timezone: rules.timezone,
    stats: dayStats(todays),
    talkMinutes: Math.round(talkSeconds / 60),
    booked: bookedActs.map((a) => {
      const l = leadById.get(a.leadId);
      return {
        leadId: a.leadId,
        name: l ? leadName(l) : "(removed)",
        phone: l?.phone ?? "",
        apptAt: (a.scheduledAt ?? l?.apptAt)?.toISOString() ?? null,
        at: a.at.toISOString(),
      };
    }),
    week: week.map((d) => ({ day: d, ...dayStats(byDay.get(d) ?? []) })),
    weekMarks: weekMarks(acts),
    prevDay: addDays(day, -1),
  };
}
