import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDayPlan, dayStats, touchFor, type DayActivity, type QueueLead } from "./queue";
import { DEFAULT_RULES, type CallRulesConfig } from "./rules";
import { zonedTimeToUtc } from "./time";

const TZ = "America/Chicago";
const rules = (o: Partial<CallRulesConfig> = {}): CallRulesConfig => ({ ...DEFAULT_RULES, timezone: TZ, ...o });
// Wednesday 2026-11-11, 10:00 Central.
const DAY = "2026-11-11";
const NOW = zonedTimeToUtc(`${DAY}T10:00`, TZ)!;
let seq = 0;
function lead(o: Partial<QueueLead> = {}): QueueLead {
  seq++;
  return {
    id: o.id ?? `lead${String(seq).padStart(6, "0")}`,
    stage: "new",
    priority: false,
    attempts: 0,
    lastAttemptDay: null,
    nextDueDay: null,
    callbackAt: null,
    apptAt: null,
    confirm48Day: null,
    confirm24Day: null,
    confirmDayOfDay: null,
    confirmedAt: null,
    skippedAt: null,
    createdAt: new Date(Date.UTC(2026, 0, 1) + seq * 1000),
    claimedById: null,
    claimedUntil: null,
    ...o,
  };
}
const ids = (plan: ReturnType<typeof buildDayPlan>, kind: string) =>
  plan.sections.find((s) => s.kind === kind)?.items.filter((i) => !i.done).map((i) => i.leadId) ?? [];

test("no list on Sundays or days that aren't calling days", () => {
  const sun = buildDayPlan({ leads: [lead()], activities: [], rules: rules(), day: "2026-11-15", now: NOW });
  assert.equal(sun.off, true);
  assert.match(sun.offReason ?? "", /Sunday/);
  const sat = buildDayPlan({ leads: [lead()], activities: [], rules: rules(), day: "2026-11-14", now: NOW });
  assert.equal(sat.off, true);
  const satOn = buildDayPlan({ leads: [lead()], activities: [], rules: rules({ workDays: [1, 2, 3, 4, 5, 6], freshDays: [6] }), day: "2026-11-14", now: NOW });
  assert.equal(satOn.off, false);
});

test("sections are worked in Dial Desk order and each lead appears once", () => {
  const cb = lead({ id: "cb000000001", stage: "nurture", callbackAt: zonedTimeToUtc(`${DAY}T15:00`, TZ) });
  const conf = lead({ id: "cf000000001", stage: "booked", apptAt: zonedTimeToUtc("2026-11-13T11:00", TZ) });
  const reb = lead({ id: "rb000000001", stage: "resched", nextDueDay: DAY });
  const cyc = lead({ id: "cy000000001", stage: "cycle", nextDueDay: "2026-11-10", attempts: 1 });
  const fresh = lead({ id: "nw000000001" });
  const plan = buildDayPlan({ leads: [fresh, cyc, reb, conf, cb], activities: [], rules: rules(), day: DAY, now: NOW });
  assert.deepEqual(plan.sections.map((s) => s.kind), ["callback", "confirm", "resched", "cycle", "fresh"]);
  assert.equal(plan.current?.leadId, "cb000000001");
  assert.equal(plan.total, 5);
  const confirm = plan.sections.find((s) => s.kind === "confirm")!.items[0];
  assert.equal(confirm.touch, "d2");
});

test("a lead already tried today waits; a follow-up isn't due before its day", () => {
  const triedToday = lead({ stage: "cycle", nextDueDay: DAY, lastAttemptDay: DAY });
  const notYet = lead({ stage: "cycle", nextDueDay: "2026-11-12" });
  const plan = buildDayPlan({ leads: [triedToday, notYet], activities: [], rules: rules(), day: DAY, now: NOW });
  assert.deepEqual(ids(plan, "cycle"), []);
});

test("new leads only on new-lead days", () => {
  // Monday is a calling day but not a new-lead day by default.
  const mon = zonedTimeToUtc("2026-11-09T10:00", TZ)!;
  const plan = buildDayPlan({ leads: [lead(), lead({ stage: "cycle", nextDueDay: "2026-11-09" })], activities: [], rules: rules(), day: "2026-11-09", now: mon });
  assert.equal(ids(plan, "fresh").length, 0);
  assert.equal(ids(plan, "cycle").length, 1);
});

test("follow-ups are capped so new leads keep their floor; the rest are held", () => {
  const cycles = Array.from({ length: 10 }, () => lead({ stage: "cycle", nextDueDay: DAY }));
  const news = Array.from({ length: 10 }, () => lead());
  const plan = buildDayPlan({ leads: [...cycles, ...news], activities: [], rules: rules({ dailyTarget: 5, freshFloor: 2 }), day: DAY, now: NOW });
  assert.equal(ids(plan, "cycle").length, 3);
  assert.equal(plan.held, 7);
  assert.equal(ids(plan, "fresh").length, 2);
  assert.equal(plan.total, 5);
});

test("priority new leads go first; extra fresh leads extend the list", () => {
  const a = lead();
  const b = lead({ priority: true });
  const plan = buildDayPlan({ leads: [a, b, lead(), lead()], activities: [], rules: rules({ dailyTarget: 1, freshFloor: 0 }), day: DAY, now: NOW });
  assert.deepEqual(ids(plan, "fresh"), [b.id]);
  const more = buildDayPlan({ leads: [a, b, lead(), lead()], activities: [], rules: rules({ dailyTarget: 1, freshFloor: 0 }), day: DAY, now: NOW, extraFresh: 2 });
  assert.equal(ids(more, "fresh").length, 3);
});

test("today's results show as done in the section they were worked in", () => {
  const worked = lead({ stage: "cycle", nextDueDay: "2026-11-13", attempts: 1, lastAttemptDay: DAY });
  const acts: DayActivity[] = [{ leadId: worked.id, kind: "fresh", outcome: "na", touch: null, at: NOW }];
  const plan = buildDayPlan({ leads: [worked, lead()], activities: acts, rules: rules({ dailyTarget: 2, freshFloor: 0 }), day: DAY, now: NOW });
  const fresh = plan.sections.find((s) => s.kind === "fresh")!;
  assert.equal(fresh.done, 1);
  assert.equal(fresh.total, 2);
  assert.equal(plan.done, 1);
  assert.equal(plan.total, 2);
});

test("a lead another agent has open is skipped for the current card", () => {
  const taken = lead({ stage: "nurture", nextDueDay: DAY, claimedById: "other", claimedUntil: new Date(NOW.getTime() + 60_000) });
  const free = lead({ stage: "nurture", nextDueDay: DAY });
  const plan = buildDayPlan({ leads: [taken, free], activities: [], rules: rules(), day: DAY, now: NOW, userId: "me" });
  assert.equal(plan.current?.leadId, free.id);
  const mine = buildDayPlan({ leads: [taken, free], activities: [], rules: rules(), day: DAY, now: NOW, userId: "other" });
  assert.equal(mine.current?.leadId, taken.id);
  const expired = buildDayPlan({ leads: [{ ...taken, claimedUntil: new Date(NOW.getTime() - 1) }, free], activities: [], rules: rules(), day: DAY, now: NOW, userId: "me" });
  assert.equal(expired.current?.leadId, taken.id);
});

test("skip for now moves a lead to the end of the day's order", () => {
  const first = lead({ stage: "nurture", nextDueDay: DAY, skippedAt: NOW });
  const second = lead({ stage: "nurture", nextDueDay: DAY });
  const plan = buildDayPlan({ leads: [first, second], activities: [], rules: rules(), day: DAY, now: NOW });
  assert.equal(plan.current?.leadId, second.id);
  const yesterday = buildDayPlan({ leads: [{ ...first, skippedAt: new Date(NOW.getTime() - 86400_000) }, second], activities: [], rules: rules(), day: DAY, now: NOW });
  assert.equal(yesterday.current?.leadId, first.id);
});

test("confirmation touches: 48h, 24h, morning-of, never after the appointment or once done", () => {
  const appt = zonedTimeToUtc(`${DAY}T15:00`, TZ)!;
  const l = lead({ stage: "booked", apptAt: appt });
  assert.equal(touchFor(l, "2026-11-09", rules(), NOW), "d2");
  assert.equal(touchFor(l, "2026-11-10", rules(), NOW), "d1");
  assert.equal(touchFor(l, DAY, rules(), NOW), "d0");
  assert.equal(touchFor(l, DAY, rules(), new Date(appt.getTime() + 1)), null);
  assert.equal(touchFor({ ...l, confirmDayOfDay: DAY }, DAY, rules(), NOW), null);
  assert.equal(touchFor({ ...l, confirmedAt: NOW }, "2026-11-10", rules(), NOW), null);
  assert.equal(touchFor(l, "2026-11-09", rules({ confirm48h: false }), NOW), null);
});

test("dayStats counts like the Dial Desk tally", () => {
  const a = (leadId: string, kind: string, outcome: string): DayActivity => ({ leadId, kind, outcome, touch: null, at: NOW });
  const s = dayStats([
    a("1", "fresh", "vm"),
    a("1", "fresh", "na"),
    a("2", "cycle", "book"),
    a("3", "callback", "cb"),
    a("4", "confirm", "conf"),
    a("5", "inbound", "book"),
    a("6", "mark", "showed"),
    a("7", "fresh", "note"),
  ]);
  assert.deepEqual(s, { dials: 5, people: 3, talked: 3, booked: 2, confirms: 1, callbacks: 1 });
});
