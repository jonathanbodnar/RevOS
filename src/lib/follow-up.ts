/**
 * Collections follow-up vocabulary for failed charges.
 *
 * Payment `status` is what the processor returned; `followUpStatus` is where
 * the human recovery work stands. Kept in one place so the admin transactions
 * page, the clinic list, the customer profile and the API route can't drift.
 */

export const FOLLOW_UP_STATUSES = [
  "new",
  "contacted",
  "promised_to_pay",
  "payment_plan",
  "card_updated",
  "recovered",
  "written_off",
  "unreachable",
] as const;

export type FollowUpStatus = (typeof FOLLOW_UP_STATUSES)[number];

export const FOLLOW_UP_LABELS: Record<FollowUpStatus, string> = {
  new: "Needs follow-up",
  contacted: "Contacted",
  promised_to_pay: "Promised to pay",
  payment_plan: "On payment plan",
  card_updated: "Card updated",
  recovered: "Recovered",
  written_off: "Written off",
  unreachable: "Unreachable",
};

/** Terminal states — the work is finished, win or lose. */
export const FOLLOW_UP_CLOSED: readonly FollowUpStatus[] = ["recovered", "written_off"];

export function isFollowUpStatus(v: unknown): v is FollowUpStatus {
  return typeof v === "string" && (FOLLOW_UP_STATUSES as readonly string[]).includes(v);
}

export function followUpLabel(v: string | null | undefined): string {
  return isFollowUpStatus(v) ? FOLLOW_UP_LABELS[v] : FOLLOW_UP_LABELS.new;
}

/** Badge class for a follow-up state, matching the repo's badge-* palette. */
export function followUpBadgeClass(v: string | null | undefined): string {
  switch (v) {
    case "recovered":
      return "badge-green";
    case "written_off":
    case "unreachable":
      return "badge-slate";
    case "contacted":
    case "promised_to_pay":
    case "payment_plan":
    case "card_updated":
      return "badge-yellow";
    default:
      return "badge-red"; // "new" — untouched, still needs a human
  }
}
