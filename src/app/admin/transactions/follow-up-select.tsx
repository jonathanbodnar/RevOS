"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  FOLLOW_UP_LABELS,
  FOLLOW_UP_STATUSES,
  followUpBadgeClass,
  type FollowUpStatus,
} from "@/lib/follow-up";

/**
 * Collections follow-up picker for a failed charge. Saves on change, then
 * refreshes so the filter counts stay honest.
 */
export function FollowUpSelect({
  chargeId,
  value,
  note,
  otherOpenCount,
}: {
  chargeId: string;
  value: string;
  note: string | null;
  /** Other still-untouched failed charges for the same patient. */
  otherOpenCount: number;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [status, setStatus] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  async function save(next: FollowUpStatus) {
    const previous = status;
    setStatus(next);
    setSaving(true);
    setError(false);
    // A single decline is frequently recorded twice, so offer to close out the
    // patient's other open rows rather than making staff repeat themselves.
    const cascade =
      otherOpenCount > 0 &&
      confirm(
        `Apply "${FOLLOW_UP_LABELS[next]}" to this patient's ${otherOpenCount} other ` +
          `failed charge${otherOpenCount === 1 ? "" : "s"} that ${otherOpenCount === 1 ? "is" : "are"} still awaiting follow-up?\n\n` +
          `OK applies to all of them. Cancel updates only this one.`,
      );
    const res = await fetch(`/api/admin/charges/${chargeId}/follow-up`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ followUpStatus: next, cascade }),
    });
    setSaving(false);
    if (!res.ok) {
      setStatus(previous);
      setError(true);
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div className="flex flex-col gap-0.5">
      <select
        className="input text-xs py-0.5 px-1 w-40"
        value={status}
        disabled={saving}
        onChange={(e) => save(e.target.value as FollowUpStatus)}
        aria-label="Follow-up status"
      >
        {FOLLOW_UP_STATUSES.map((s) => (
          <option key={s} value={s}>
            {FOLLOW_UP_LABELS[s]}
          </option>
        ))}
      </select>
      {note && <span className="text-xs text-slate-500 max-w-40 truncate">{note}</span>}
      {error && <span className="text-xs text-red-600">Save failed</span>}
    </div>
  );
}

/** Read-only badge for surfaces where follow-up isn't editable. */
export function FollowUpBadge({ value }: { value: string | null | undefined }) {
  const v = value ?? "new";
  return <span className={followUpBadgeClass(v)}>{FOLLOW_UP_LABELS[v as FollowUpStatus] ?? v}</span>;
}
