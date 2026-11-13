/**
 * Call center vocabulary: lead stages, list sections, call outcomes.
 *
 * Ported from the Dial Desk prototype the call center already used (stored in
 * IndexedDB, no server). The keys are the prototype's so imported history and
 * the desk logic in queue.ts / outcomes.ts read the same way. Isomorphic: no
 * server imports, safe in client components.
 */

export const STAGES = [
  "new",
  "cycle",
  "nurture",
  "booked",
  "resched",
  "handed",
  "showed",
  "lost",
  "dnq",
  "dnc",
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  new: "New",
  cycle: "No answer",
  nurture: "Call back",
  booked: "Booked",
  resched: "Rebook",
  handed: "Front desk to text",
  showed: "Showed",
  lost: "Lost",
  dnq: "Not qualified",
  dnc: "Do not call",
};

/** Badge colour per stage (RevOS badge classes). */
export const STAGE_BADGE: Record<Stage, string> = {
  new: "badge-slate",
  cycle: "badge-yellow",
  nurture: "badge-purple",
  booked: "badge-green",
  resched: "badge-yellow",
  handed: "badge-red",
  showed: "badge-indigo",
  lost: "badge-slate",
  dnq: "badge-slate",
  dnc: "badge-red",
};

export function isStage(v: unknown): v is Stage {
  return typeof v === "string" && (STAGES as readonly string[]).includes(v);
}

/** Sections of the day's list, in the order they are worked. */
export const QUEUE_KINDS = ["callback", "confirm", "resched", "cycle", "fresh"] as const;
export type QueueKind = (typeof QUEUE_KINDS)[number];
/** A lead opened from search ("manual") or a patient who called in ("inbound"). */
export type ItemKind = QueueKind | "manual" | "inbound";

export const KIND_LABEL: Record<ItemKind, { label: string; tag: string }> = {
  callback: { label: "Callbacks", tag: "Callback" },
  confirm: { label: "Confirmations", tag: "Confirm" },
  resched: { label: "Rebooks", tag: "Rebook" },
  cycle: { label: "Follow-ups", tag: "Follow-up" },
  fresh: { label: "New leads", tag: "New lead" },
  manual: { label: "Opened", tag: "Opened" },
  inbound: { label: "They called", tag: "They called you" },
};

export function isItemKind(v: unknown): v is ItemKind {
  return (
    typeof v === "string" &&
    ((QUEUE_KINDS as readonly string[]).includes(v) || v === "manual" || v === "inbound")
  );
}

/** Confirmation touches before an appointment. */
export const TOUCHES = ["d2", "d1", "d0"] as const;
export type Touch = (typeof TOUCHES)[number];
export const TOUCH_LABEL: Record<Touch, string> = {
  d2: "48-hour call",
  d1: "24-hour call",
  d0: "Morning-of call",
};
export function isTouch(v: unknown): v is Touch {
  return typeof v === "string" && (TOUCHES as readonly string[]).includes(v);
}

/** Results the agent picks after a call. */
export const CALL_OUTCOMES = [
  "na",
  "vm",
  "book",
  "cb",
  "ni",
  "dnq",
  "dnc",
  "conf",
  "cna",
  "resch",
  "cancel",
  "note",
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];
export function isCallOutcome(v: unknown): v is CallOutcome {
  return typeof v === "string" && (CALL_OUTCOMES as readonly string[]).includes(v);
}

/** Updates made without a call (the clinic reports back, or the agent edits). */
export const MARKS = ["showed", "cancelled", "noshow", "recycle"] as const;
export type Mark = (typeof MARKS)[number];
export function isMark(v: unknown): v is Mark {
  return typeof v === "string" && (MARKS as readonly string[]).includes(v);
}

/** Outcomes that mean we spoke to the person (they reset the no-answer count). */
export const TALK = new Set<string>(["book", "cb", "ni", "dnq", "dnc"]);

/** Outcomes that need a date and time. */
export const NEEDS_WHEN = new Set<string>(["book", "cb", "resch"]);

export const OUTCOME_LABEL: Record<string, string> = {
  na: "No answer",
  vm: "Straight to voicemail",
  book: "Booked",
  cb: "Call back set",
  ni: "Not interested",
  dnq: "Not qualified",
  dnc: "Remove, do not call",
  conf: "Confirmed",
  cna: "No answer, voicemail left",
  resch: "Rescheduled",
  cancel: "Cancelled",
  note: "Note",
  showed: "Showed",
  cancelled: "Clinic: cancelled",
  noshow: "Clinic: no-show",
  recycle: "Back in rotation",
  stage: "Status changed",
  appt: "Appointment set",
  priority: "Priority changed",
  missed: "Missed call (they called)",
  imported: "Imported",
  status: "Status updated from import",
};

export type OutcomeButton = {
  outcome: CallOutcome;
  label: string;
  /** Keyboard shortcut. */
  key: string;
  tone: "" | "good" | "gold" | "bad";
};

/** The outcome buttons for each kind of call, as on the Dial Desk. */
export const OUTCOME_SETS: Record<"call" | "inbound" | "confirm", OutcomeButton[]> = {
  call: [
    { outcome: "na", label: "No answer", key: "1", tone: "" },
    { outcome: "vm", label: "Straight to voicemail", key: "2", tone: "" },
    { outcome: "book", label: "Booked", key: "3", tone: "good" },
    { outcome: "cb", label: "Call back", key: "4", tone: "gold" },
    { outcome: "ni", label: "Not interested", key: "5", tone: "bad" },
    { outcome: "dnq", label: "Not qualified", key: "6", tone: "bad" },
    { outcome: "dnc", label: "Remove, do not call", key: "7", tone: "bad" },
  ],
  inbound: [
    { outcome: "book", label: "Booked", key: "3", tone: "good" },
    { outcome: "cb", label: "Call back", key: "4", tone: "gold" },
    { outcome: "ni", label: "Not interested", key: "5", tone: "bad" },
    { outcome: "dnq", label: "Not qualified", key: "6", tone: "bad" },
    { outcome: "dnc", label: "Remove, do not call", key: "7", tone: "bad" },
  ],
  confirm: [
    { outcome: "conf", label: "Confirmed", key: "1", tone: "good" },
    { outcome: "cna", label: "No answer, left voicemail", key: "2", tone: "" },
    { outcome: "resch", label: "Rescheduled", key: "3", tone: "gold" },
    { outcome: "cancel", label: "Cancelled", key: "4", tone: "bad" },
  ],
};

export function outcomeSetFor(kind: ItemKind): OutcomeButton[] {
  if (kind === "confirm") return OUTCOME_SETS.confirm;
  if (kind === "inbound") return OUTCOME_SETS.inbound;
  return OUTCOME_SETS.call;
}

/** Display name for a lead row. */
export function leadName(l: { firstName?: string | null; lastName?: string | null }): string {
  const n = [l.firstName, l.lastName].filter((x) => x && x.trim()).join(" ").trim();
  return n || "(no name)";
}
