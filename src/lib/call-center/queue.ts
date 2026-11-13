/**
 * The day's call list, computed from lead state.
 *
 * A port of the Dial Desk's buildPlan(). The prototype stored a plan per day
 * in the browser; here the list is recomputed on every request from the
 * database, so several agents (and the auto dialer) share one truth:
 *   - "remaining" items come from each lead's current stage and due dates;
 *   - "done" items come from today's LeadActivity rows (kind = list section).
 * Sections are worked in order: callbacks, confirmations, rebooks, follow-ups,
 * new leads. Follow-ups are capped so new leads keep at least `freshFloor`
 * places on fresh days; whatever doesn't fit is "held" for the next work day.
 *
 * Pure and isomorphic so it is unit-tested without a database.
 */
import type { CallRulesConfig } from "./rules";
import { QUEUE_KINDS, TALK, type QueueKind, type Touch } from "./stages";
import { dayInTz, diffDays, isWorkDay, dow, type Day } from "./time";

export type QueueLead = {
  id: string;
  stage: string;
  priority: boolean;
  attempts: number;
  lastAttemptDay: string | null;
  nextDueDay: string | null;
  callbackAt: Date | null;
  apptAt: Date | null;
  confirm48Day: string | null;
  confirm24Day: string | null;
  confirmDayOfDay: string | null;
  confirmedAt: Date | null;
  skippedAt: Date | null;
  createdAt: Date;
  claimedById: string | null;
  claimedUntil: Date | null;
};

export type DayActivity = {
  leadId: string;
  kind: string;
  outcome: string;
  touch: string | null;
  at: Date;
};

export type QueueItem = {
  leadId: string;
  kind: QueueKind;
  touch?: Touch;
  done: boolean;
  /** Another agent (or their auto dialer) has this lead open right now. */
  claimedByOther: boolean;
};

export type QueueSection = { kind: QueueKind; items: QueueItem[]; done: number; total: number };

export type DayPlan = {
  day: Day;
  off: boolean;
  offReason?: string;
  sections: QueueSection[];
  total: number;
  done: number;
  /** Follow-ups due today that didn't fit; they go first next work day. */
  held: number;
  freshToday: number;
  /** The next item to call, or null when the list is done. */
  current: QueueItem | null;
};

const ACTIVE_CLAIM = (l: QueueLead, me: string | null, now: Date) =>
  !!l.claimedById && l.claimedById !== me && !!l.claimedUntil && l.claimedUntil > now;

function touchDone(l: QueueLead, t: Touch): boolean {
  if (t === "d2") return !!l.confirm48Day;
  if (t === "d1") return !!l.confirm24Day;
  return !!l.confirmDayOfDay;
}

/** Which confirmation call (if any) a booked lead needs on `day`. */
export function touchFor(l: QueueLead, day: Day, rules: CallRulesConfig, now: Date): Touch | null {
  if (l.stage !== "booked" || !l.apptAt || l.confirmedAt) return null;
  const diff = diffDays(day, dayInTz(l.apptAt, rules.timezone));
  const key: Touch | null = diff === 2 ? "d2" : diff === 1 ? "d1" : diff === 0 ? "d0" : null;
  if (!key) return null;
  if (key === "d2" && !rules.confirm48h) return null;
  if (key === "d1" && !rules.confirm24h) return null;
  if (key === "d0" && !rules.confirmDayOf) return null;
  if (touchDone(l, key)) return null;
  if (key === "d0" && l.apptAt <= now) return null;
  return key;
}

/** Is a "call back" lead due on `day`? */
export function callbackDue(l: QueueLead, day: Day, tz: string): boolean {
  if (l.stage !== "nurture") return false;
  if (l.callbackAt) return dayInTz(l.callbackAt, tz) <= day;
  return !!l.nextDueDay && l.nextDueDay <= day && l.lastAttemptDay !== day;
}

const dueOn = (l: QueueLead, day: Day) =>
  !!l.nextDueDay && l.nextDueDay <= day && l.lastAttemptDay !== day;

const byDue = (a: QueueLead, b: QueueLead) =>
  (a.nextDueDay || "").localeCompare(b.nextDueDay || "") ||
  Number(b.priority) - Number(a.priority) ||
  a.createdAt.getTime() - b.createdAt.getTime();

const byFresh = (a: QueueLead, b: QueueLead) =>
  Number(b.priority) - Number(a.priority) || a.createdAt.getTime() - b.createdAt.getTime();

/** Leads the auto-dialer / list should consider (new leads ordered for picking). */
export const ACTIVE_STAGES = ["new", "cycle", "nurture", "booked", "resched"] as const;

export function buildDayPlan(input: {
  leads: QueueLead[];
  activities: DayActivity[];
  rules: CallRulesConfig;
  day: Day;
  now: Date;
  extraFresh?: number;
  /** The agent asking (their own claims don't block them). */
  userId?: string | null;
}): DayPlan {
  const { leads, activities, rules, day, now } = input;
  const me = input.userId ?? null;
  const tz = rules.timezone;
  const base: DayPlan = { day, off: false, sections: [], total: 0, done: 0, held: 0, freshToday: 0, current: null };

  if (dow(day) === 0) return { ...base, off: true, offReason: "Sunday: no calls." };
  if (!isWorkDay(day, rules.workDays)) {
    return { ...base, off: true, offReason: "Today isn't one of this clinic's calling days. Change work days on the Rules page." };
  }
  const freshDay = rules.freshDays.includes(dow(day));

  // Done: the first list section each lead was worked in today.
  const doneBy = new Map<string, { kind: QueueKind; touch?: Touch }>();
  for (const a of [...activities].sort((x, y) => x.at.getTime() - y.at.getTime())) {
    if (a.outcome === "note") continue;
    if (!(QUEUE_KINDS as readonly string[]).includes(a.kind)) continue;
    if (!doneBy.has(a.leadId)) {
      doneBy.set(a.leadId, { kind: a.kind as QueueKind, touch: (a.touch as Touch) || undefined });
    }
  }

  const byId = new Map(leads.map((l) => [l.id, l]));
  const seen = new Set<string>();
  const remaining: QueueItem[] = [];
  const push = (l: QueueLead, kind: QueueKind, touch?: Touch) => {
    if (seen.has(l.id)) return;
    seen.add(l.id);
    remaining.push({ leadId: l.id, kind, touch, done: false, claimedByOther: ACTIVE_CLAIM(l, me, now) });
  };

  const cbKey = (l: QueueLead) => (l.callbackAt ? l.callbackAt.toISOString() : `${l.nextDueDay}T00:00`);
  leads
    .filter((l) => callbackDue(l, day, tz))
    .sort((a, b) => cbKey(a).localeCompare(cbKey(b)))
    .forEach((l) => push(l, "callback"));
  leads
    .map((l) => ({ l, t: touchFor(l, day, rules, now) }))
    .filter((x) => x.t)
    .sort((a, b) => a.l.apptAt!.getTime() - b.l.apptAt!.getTime())
    .forEach(({ l, t }) => push(l, "confirm", t!));
  leads
    .filter((l) => l.stage === "resched" && dueOn(l, day))
    .sort(byDue)
    .forEach((l) => push(l, "resched"));

  const priorityCount = remaining.length;
  const cycles = leads.filter((l) => l.stage === "cycle" && dueOn(l, day)).sort(byDue);
  const cycleRoom = Math.max(0, rules.dailyTarget - doneBy.size - priorityCount - (freshDay ? rules.freshFloor : 0));
  const cyclesTaken = cycles.slice(0, cycleRoom);
  cyclesTaken.forEach((l) => push(l, "cycle"));
  const held = Math.max(0, cycles.length - cyclesTaken.length);

  let freshToday = 0;
  if (freshDay) {
    const room = Math.max(0, rules.dailyTarget - doneBy.size - remaining.length) + (input.extraFresh ?? 0);
    const fresh = leads.filter((l) => l.stage === "new" && !seen.has(l.id)).sort(byFresh).slice(0, room);
    fresh.forEach((l) => push(l, "fresh"));
    freshToday = fresh.length;
  }

  // Skipped-for-now leads go to the end of the day's order.
  const skippedToday = (id: string) => {
    const l = byId.get(id);
    return !!l?.skippedAt && dayInTz(l.skippedAt, tz) === day;
  };
  const order = [...remaining.filter((i) => !skippedToday(i.leadId)), ...remaining.filter((i) => skippedToday(i.leadId))];

  const sections: QueueSection[] = QUEUE_KINDS.map((kind) => {
    const done: QueueItem[] = [];
    for (const [leadId, d] of doneBy) {
      if (d.kind === kind) done.push({ leadId, kind, touch: d.touch, done: true, claimedByOther: false });
    }
    const open = order.filter((i) => i.kind === kind);
    return { kind, items: [...done, ...open], done: done.length, total: done.length + open.length };
  }).filter((s) => s.total > 0);

  const freshDone = [...doneBy.values()].filter((d) => d.kind === "fresh").length;
  const current = order.find((i) => !i.claimedByOther) ?? null;
  return {
    day,
    off: false,
    sections,
    total: doneBy.size + remaining.length,
    done: doneBy.size,
    held,
    freshToday: freshToday + freshDone,
    current,
  };
}

/** Pick the next lead the auto dialer may dial, in list order. */
export function nextDialable(plan: DayPlan, ok: (leadId: string, kind: QueueKind) => boolean): QueueItem | null {
  for (const s of plan.sections) {
    for (const it of s.items) {
      if (it.done || it.claimedByOther) continue;
      if (ok(it.leadId, it.kind)) return it;
    }
  }
  return null;
}

export type DayStats = {
  dials: number;
  people: number;
  talked: number;
  booked: number;
  confirms: number;
  callbacks: number;
};

/** The Dial Desk's tally for one day's activities. */
export function dayStats(activities: DayActivity[]): DayStats {
  let dials = 0;
  let booked = 0;
  let callbacks = 0;
  const people = new Set<string>();
  const talked = new Set<string>();
  const confirmed = new Set<string>();
  for (const e of activities) {
    if (e.kind === "mark" || e.kind === "import" || e.outcome === "note") continue;
    if (e.kind === "confirm") {
      dials++;
      confirmed.add(e.leadId);
      continue;
    }
    if (e.kind !== "inbound" && e.outcome !== "missed") {
      dials++;
      people.add(e.leadId);
    }
    if (TALK.has(e.outcome)) talked.add(e.leadId);
    if (e.outcome === "book") booked++;
    if (e.outcome === "cb") callbacks++;
  }
  return { dials, people: people.size, talked: talked.size, booked, confirms: confirmed.size, callbacks };
}

export type WeekMarks = { booked: number; confirmed: number; showed: number; cancelled: number; noshow: number };

export function weekMarks(activities: { outcome: string }[]): WeekMarks {
  const w: WeekMarks = { booked: 0, confirmed: 0, showed: 0, cancelled: 0, noshow: 0 };
  for (const e of activities) {
    if (e.outcome === "book") w.booked++;
    else if (e.outcome === "conf") w.confirmed++;
    else if (e.outcome === "showed") w.showed++;
    else if (e.outcome === "cancelled") w.cancelled++;
    else if (e.outcome === "noshow") w.noshow++;
  }
  return w;
}
