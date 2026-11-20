/**
 * What a call result does to a lead. A port of the Dial Desk's logOutcome(),
 * finishNA() and markContact(), kept pure: it returns the field changes and
 * history entries, and the server layer writes them (encrypting notes).
 *
 * The double-dial: "Straight to voicemail" on the first dial doesn't finish the
 * lead. The desk keeps it open ("dial once more right now"), and the result of
 * the second dial is sent with `redial: true`. A second voicemail finishes it
 * as a no-answer. Voicemails are never left on these calls.
 */
import type { CallRulesConfig } from "./rules";
import { TALK, type CallOutcome, type ItemKind, type Mark, type Stage, type Touch } from "./stages";
import { addWorkDays, dayInTz, nextWorkDay, type Day } from "./time";

export type OutcomeLead = {
  stage: string;
  attempts: number;
  dials: number;
  lastAttemptDay: string | null;
  apptAt: Date | null;
};

export type LeadPatch = Partial<{
  stage: Stage;
  attempts: number;
  dials: number;
  lastCalledAt: Date;
  lastAttemptDay: string | null;
  nextDueDay: string | null;
  callbackAt: Date | null;
  apptAt: Date | null;
  confirm48Day: string | null;
  confirm24Day: string | null;
  confirmDayOfDay: string | null;
  confirmedAt: Date | null;
  needsTextDay: string | null;
  lostReason: string | null;
  lastNote: string;
  skippedAt: Date | null;
  priority: boolean;
}>;

export type ActivityDraft = {
  kind: string;
  outcome: string;
  touch?: Touch | null;
  scheduledAt?: Date | null;
  note?: string | null;
};

export type OutcomeResult =
  | { ok: false; error: string }
  | {
      ok: true;
      patch: LeadPatch;
      activities: ActivityDraft[];
      /** Move on to the next lead (false keeps this one open). */
      advance: boolean;
      /** Keep this lead pinned for the second dial of a double-dial. */
      redialNext: boolean;
      message: string;
    };

const CONFIRM_FIELD: Record<Touch, "confirm48Day" | "confirm24Day" | "confirmDayOfDay"> = {
  d2: "confirm48Day",
  d1: "confirm24Day",
  d0: "confirmDayOfDay",
};

const RESET_CONFIRMS = { confirm48Day: null, confirm24Day: null, confirmDayOfDay: null, confirmedAt: null } as const;

/** "11/3" from a day, the Dial Desk's note prefix. */
export function mmdd(day: Day): string {
  const [, m, d] = day.split("-");
  return `${Number(m)}/${Number(d)}`;
}

export function applyOutcome(input: {
  lead: OutcomeLead;
  kind: ItemKind;
  touch?: Touch | null;
  outcome: CallOutcome;
  scheduledAt?: Date | null;
  note?: string | null;
  redial?: boolean;
  day: Day;
  now: Date;
  rules: CallRulesConfig;
}): OutcomeResult {
  const { lead, kind, outcome, day, now, rules } = input;
  const note = (input.note || "").trim();
  const when = input.scheduledAt ?? null;
  const touch = input.touch ?? null;

  if (outcome === "note" && !note) return { ok: false, error: "Type a note first." };
  if ((outcome === "book" || outcome === "cb" || outcome === "resch") && !when) {
    return { ok: false, error: outcome === "cb" ? "Pick when to call back." : "Pick the appointment date and time." };
  }
  if (outcome === "cb" && when && when.getTime() < now.getTime() - 60_000) {
    return { ok: false, error: "The call-back time is in the past." };
  }
  if ((outcome === "conf" || outcome === "cna") && (kind !== "confirm" || !touch)) {
    return { ok: false, error: "That result is only for confirmation calls." };
  }
  if ((outcome === "resch" || outcome === "cancel") && lead.stage !== "booked") {
    return { ok: false, error: "Only booked appointments can be moved or cancelled." };
  }

  const patch: LeadPatch = {};
  const activities: ActivityDraft[] = [{ kind, outcome, touch: kind === "confirm" ? touch : null, scheduledAt: when, note: note || null }];
  let stage = lead.stage as Stage;
  let attempts = lead.attempts || 0;
  let lastAttemptDay = lead.lastAttemptDay;

  if (outcome !== "note") {
    if (kind !== "inbound") patch.dials = (lead.dials || 0) + 1;
    patch.lastCalledAt = now;
  }
  if (note) patch.lastNote = `${mmdd(day)}: ${note}`;

  const outbound = kind !== "inbound" && kind !== "confirm";
  if ((outcome === "na" || outcome === "vm") && outbound) {
    if (lastAttemptDay !== day) attempts += 1;
    lastAttemptDay = day;
  }
  if (TALK.has(outcome)) {
    attempts = 0;
    lastAttemptDay = day;
  }

  const finish = (advance: boolean, message: string, redialNext = false): OutcomeResult => {
    patch.stage = stage;
    patch.attempts = attempts;
    patch.lastAttemptDay = lastAttemptDay;
    return { ok: true, patch, activities, advance, redialNext, message };
  };

  const finishNA = (): OutcomeResult => {
    let message = "";
    if (kind === "resched" || stage === "resched") {
      if (attempts >= rules.rebookAttempts) {
        stage = "handed";
        patch.nextDueDay = null;
        patch.needsTextDay = day;
        message = "Added to the front-desk text list.";
      } else {
        stage = "resched";
        patch.nextDueDay = nextWorkDay(day, rules.workDays);
      }
    } else if (stage === "nurture") {
      if (attempts >= rules.maxAttempts) {
        stage = "lost";
        patch.lostReason = "Unable to contact";
        patch.nextDueDay = null;
        patch.callbackAt = null;
        message = `${rules.maxAttempts} tries with no answer. Marked unable to contact.`;
      } else {
        patch.nextDueDay = addWorkDays(day, rules.spacingDays, rules.workDays);
        patch.callbackAt = null;
      }
    } else if (stage === "booked" || stage === "showed") {
      // A manual call to someone already booked: no status change.
    } else {
      if (attempts >= rules.maxAttempts) {
        stage = "lost";
        patch.lostReason = "Unable to contact";
        patch.nextDueDay = null;
        patch.callbackAt = null;
        message = `${rules.maxAttempts} tries with no answer. Marked unable to contact.`;
      } else {
        stage = "cycle";
        patch.nextDueDay = addWorkDays(day, rules.spacingDays, rules.workDays);
      }
    }
    return finish(true, message);
  };

  switch (outcome) {
    case "vm":
      if (input.redial || !rules.doubleDial || !outbound) return finishNA();
      if (stage === "new") stage = "cycle";
      return finish(false, "Dial once more right now. Pick the result of the second dial.", true);
    case "na":
      return finishNA();
    case "book":
      stage = "booked";
      Object.assign(patch, RESET_CONFIRMS, { apptAt: when, nextDueDay: null, callbackAt: null, needsTextDay: null });
      return finish(true, "Booked. Log it on the consults form.");
    case "cb":
      stage = "nurture";
      patch.callbackAt = when;
      patch.nextDueDay = dayInTz(when!, rules.timezone);
      return finish(true, "Call back set.");
    case "ni":
      stage = "lost";
      Object.assign(patch, { lostReason: "Not interested", nextDueDay: null, callbackAt: null });
      return finish(true, "");
    case "dnq":
      stage = "dnq";
      Object.assign(patch, { nextDueDay: null, callbackAt: null });
      return finish(true, "");
    case "dnc":
      stage = "dnc";
      Object.assign(patch, { nextDueDay: null, callbackAt: null });
      return finish(true, "Removed. They won't be called again.");
    case "conf":
      patch.confirmedAt = now;
      patch[CONFIRM_FIELD[touch!]] = day;
      return finish(true, "Confirmed. No more confirmation calls for this one.");
    case "cna":
      patch[CONFIRM_FIELD[touch!]] = day;
      if (touch === "d0") {
        patch.needsTextDay = day;
        return finish(true, "Not reached on the day. Added to the front-desk text list.");
      }
      return finish(true, "");
    case "resch":
      Object.assign(patch, RESET_CONFIRMS, { apptAt: when });
      return finish(true, "Appointment moved.");
    case "cancel":
      stage = "resched";
      attempts = 0;
      Object.assign(patch, { apptAt: null, nextDueDay: nextWorkDay(day, rules.workDays) });
      activities.push({ kind: "mark", outcome: "cancelled" });
      return finish(true, "Moved to rebooks, starting next work day.");
    case "note":
      return { ok: true, patch, activities, advance: false, redialNext: false, message: "Note saved." };
  }
}

/** Updates without a call: the clinic reports a show / cancel / no-show, or the lead goes back in rotation. */
export function applyMark(mark: Mark, day: Day): { patch: LeadPatch; activity: ActivityDraft; message: string } {
  switch (mark) {
    case "showed":
      return { patch: { stage: "showed" }, activity: { kind: "mark", outcome: "showed" }, message: "Marked showed." };
    case "cancelled":
    case "noshow":
      return {
        patch: { stage: "resched", attempts: 0, lastAttemptDay: null, nextDueDay: day, apptAt: null, ...RESET_CONFIRMS },
        activity: { kind: "mark", outcome: mark },
        message: "Moved to rebooks.",
      };
    case "recycle":
      return {
        patch: { stage: "new", attempts: 0, nextDueDay: null, lostReason: null, callbackAt: null },
        activity: { kind: "mark", outcome: "recycle" },
        message: "Back in rotation.",
      };
  }
}

/** Set a stage by hand (the "Update without a call" status picker). */
export function applyStage(stage: Stage, day: Day): LeadPatch {
  const p: LeadPatch = { stage };
  if (stage === "new") Object.assign(p, { attempts: 0, nextDueDay: null, lostReason: null });
  if (stage === "cycle" || stage === "resched" || stage === "nurture") p.nextDueDay = day;
  if (stage === "lost") Object.assign(p, { nextDueDay: null, callbackAt: null, lostReason: "Set by hand" });
  if (stage === "dnq" || stage === "dnc" || stage === "showed" || stage === "handed") {
    Object.assign(p, { nextDueDay: null, callbackAt: null });
  }
  return p;
}
