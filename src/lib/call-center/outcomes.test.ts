import { test } from "node:test";
import assert from "node:assert/strict";
import { applyMark, applyOutcome, type OutcomeLead } from "./outcomes";
import { DEFAULT_RULES, type CallRulesConfig } from "./rules";
import { zonedTimeToUtc } from "./time";

const TZ = "America/Chicago";
const rules = (o: Partial<CallRulesConfig> = {}): CallRulesConfig => ({ ...DEFAULT_RULES, timezone: TZ, ...o });
const DAY = "2026-11-11"; // Wednesday
const NOW = zonedTimeToUtc(`${DAY}T10:00`, TZ)!;
const base = (o: Partial<OutcomeLead> = {}): OutcomeLead => ({ stage: "new", attempts: 0, dials: 0, lastAttemptDay: null, apptAt: null, ...o });
const run = (o: Partial<Parameters<typeof applyOutcome>[0]>) =>
  applyOutcome({ lead: base(), kind: "fresh", outcome: "na", day: DAY, now: NOW, rules: rules(), ...o });

test("no answer: one try, follow-up in two work days", () => {
  const r = run({});
  assert.ok(r.ok);
  assert.equal(r.patch.stage, "cycle");
  assert.equal(r.patch.attempts, 1);
  assert.equal(r.patch.lastAttemptDay, DAY);
  assert.equal(r.patch.nextDueDay, "2026-11-13");
  assert.equal(r.patch.dials, 1);
  assert.equal(r.advance, true);
});

test("the fourth no-answer marks them unable to contact", () => {
  const r = run({ lead: base({ stage: "cycle", attempts: 3, lastAttemptDay: "2026-11-09" }), kind: "cycle" });
  assert.ok(r.ok);
  assert.equal(r.patch.stage, "lost");
  assert.equal(r.patch.lostReason, "Unable to contact");
  assert.equal(r.patch.nextDueDay, null);
});

test("double-dial: first voicemail keeps the lead open; the second finishes it as one try", () => {
  const first = run({ outcome: "vm" });
  assert.ok(first.ok);
  assert.equal(first.advance, false);
  assert.equal(first.redialNext, true);
  assert.equal(first.patch.stage, "cycle");
  assert.equal(first.patch.attempts, 1);
  const second = run({ lead: base({ stage: "cycle", attempts: 1, lastAttemptDay: DAY }), outcome: "vm", redial: true });
  assert.ok(second.ok);
  assert.equal(second.advance, true);
  assert.equal(second.patch.attempts, 1, "same day: still one try");
  assert.equal(second.patch.nextDueDay, "2026-11-13");
  const noDouble = run({ outcome: "vm", rules: rules({ doubleDial: false }) });
  assert.ok(noDouble.ok);
  assert.equal(noDouble.advance, true);
});

test("booked needs a time, and resets confirmation calls", () => {
  assert.deepEqual(run({ outcome: "book" }), { ok: false, error: "Pick the appointment date and time." });
  const when = zonedTimeToUtc("2026-11-16T10:00", TZ)!;
  const r = run({ outcome: "book", scheduledAt: when, note: "Wants mornings" });
  assert.ok(r.ok);
  assert.equal(r.patch.stage, "booked");
  assert.equal(r.patch.apptAt, when);
  assert.equal(r.patch.confirm48Day, null);
  assert.equal(r.patch.attempts, 0);
  assert.equal(r.patch.lastNote, "11/11: Wants mornings");
  assert.equal(r.activities[0].scheduledAt, when);
});

test("call back sets the time and the clinic-local due day", () => {
  const when = zonedTimeToUtc("2026-11-12T17:00", TZ)!;
  const r = run({ outcome: "cb", scheduledAt: when });
  assert.ok(r.ok);
  assert.equal(r.patch.stage, "nurture");
  assert.equal(r.patch.callbackAt, when);
  assert.equal(r.patch.nextDueDay, "2026-11-12");
  assert.equal(run({ outcome: "cb", scheduledAt: new Date(NOW.getTime() - 3600_000) }).ok, false);
});

test("not interested, not qualified, do not call", () => {
  const ni = run({ outcome: "ni" });
  assert.ok(ni.ok && ni.patch.stage === "lost" && ni.patch.lostReason === "Not interested");
  const dnq = run({ outcome: "dnq" });
  assert.ok(dnq.ok && dnq.patch.stage === "dnq");
  const dnc = run({ outcome: "dnc" });
  assert.ok(dnc.ok && dnc.patch.stage === "dnc" && dnc.patch.nextDueDay === null);
});

test("confirmations: confirmed stops them; no answer on the day goes to the front desk", () => {
  const booked = base({ stage: "booked", apptAt: zonedTimeToUtc(`${DAY}T15:00`, TZ) });
  const conf = run({ lead: booked, kind: "confirm", touch: "d1", outcome: "conf" });
  assert.ok(conf.ok);
  assert.equal(conf.patch.confirm24Day, DAY);
  assert.ok(conf.patch.confirmedAt);
  const cna = run({ lead: booked, kind: "confirm", touch: "d0", outcome: "cna" });
  assert.ok(cna.ok);
  assert.equal(cna.patch.confirmDayOfDay, DAY);
  assert.equal(cna.patch.needsTextDay, DAY);
  assert.equal(run({ lead: booked, kind: "fresh", outcome: "conf" }).ok, false);
});

test("cancelled appointments become rebooks from the next work day", () => {
  const booked = base({ stage: "booked", apptAt: zonedTimeToUtc("2026-11-13T15:00", TZ) });
  const r = run({ lead: booked, kind: "confirm", touch: "d2", outcome: "cancel" });
  assert.ok(r.ok);
  assert.equal(r.patch.stage, "resched");
  assert.equal(r.patch.apptAt, null);
  assert.equal(r.patch.nextDueDay, "2026-11-12");
  assert.deepEqual(r.activities.map((a) => a.outcome), ["cancel", "cancelled"]);
  assert.equal(run({ lead: base(), outcome: "cancel" }).ok, false);
});

test("rebooks: after the allowed tries the front desk texts them", () => {
  const r = run({ lead: base({ stage: "resched", attempts: 2, lastAttemptDay: "2026-11-10" }), kind: "resched", outcome: "na" });
  assert.ok(r.ok);
  assert.equal(r.patch.stage, "handed");
  assert.equal(r.patch.needsTextDay, DAY);
  const early = run({ lead: base({ stage: "resched", attempts: 0 }), kind: "resched", outcome: "na" });
  assert.ok(early.ok);
  assert.equal(early.patch.stage, "resched");
  assert.equal(early.patch.nextDueDay, "2026-11-12");
});

test("a note alone needs text and doesn't count as a dial", () => {
  assert.deepEqual(run({ outcome: "note" }), { ok: false, error: "Type a note first." });
  const r = run({ outcome: "note", note: "Prefers texts" });
  assert.ok(r.ok);
  assert.equal(r.advance, false);
  assert.equal(r.patch.dials, undefined);
});

test("clinic marks", () => {
  assert.equal(applyMark("showed", DAY).patch.stage, "showed");
  const ns = applyMark("noshow", DAY);
  assert.equal(ns.patch.stage, "resched");
  assert.equal(ns.patch.nextDueDay, DAY);
  assert.equal(applyMark("recycle", DAY).patch.stage, "new");
});
