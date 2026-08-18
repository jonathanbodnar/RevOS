"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

export type ChartWeekRow = {
  weekNumber: number;
  rangeLabel: string; // e.g. "Jul 1 – Jul 7"
  scheduled: boolean;
  completed: boolean;
  notes: string;
  isCurrent: boolean;
  isFuture: boolean;
  scan: { id: string; dateLabel: string; summary: string } | null;
};

export function ProgramChart({
  customerId,
  signedDate,
  initialWeeks,
  canEdit,
}: {
  customerId: string;
  signedDate: string | null;
  initialWeeks: ChartWeekRow[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [weeks, setWeeks] = useState<ChartWeekRow[]>(initialWeeks);
  const [signed, setSigned] = useState(signedDate ?? "");
  const [savingWeek, setSavingWeek] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  // Re-sync to server truth whenever the server re-renders (after a
  // router.refresh()): recomputed week ranges when the signed date changes,
  // and a rollback of any optimistic edit whose save failed.
  useEffect(() => {
    setWeeks(initialWeeks);
  }, [initialWeeks]);
  useEffect(() => {
    setSigned(signedDate ?? "");
  }, [signedDate]);

  async function put(body: unknown) {
    const res = await fetch(`/api/clinic/customers/${customerId}/chart`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(d.error || "Save failed");
    }
    return res.json();
  }

  async function saveSignedDate(value: string) {
    setError(null);
    setSavedNote(null);
    try {
      await put({ signedDate: value || null });
      // Moving the anchor re-dates every week, so say what happened rather
      // than leaving the grid to silently redraw.
      setSavedNote(
        value
          ? "Saved — week dates updated. Week numbers stay put; the notes on each week keep their week number."
          : "Cleared — weeks now count from the first payment.",
      );
      // Week ranges shift with the anchor — re-read from the server.
      startTransition(() => router.refresh());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function saveWeek(
    weekNumber: number,
    patch: Partial<Pick<ChartWeekRow, "scheduled" | "completed" | "notes">>,
  ) {
    setError(null);
    setSavingWeek(weekNumber);
    // Optimistic update.
    setWeeks((prev) =>
      prev.map((w) => (w.weekNumber === weekNumber ? { ...w, ...patch } : w)),
    );
    try {
      await put({
        weekNumber,
        ...(patch.scheduled !== undefined ? { scheduled: patch.scheduled } : {}),
        ...(patch.completed !== undefined ? { completed: patch.completed } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      });
    } catch (e) {
      setError((e as Error).message);
      startTransition(() => router.refresh()); // roll back to server truth
    } finally {
      setSavingWeek(null);
    }
  }

  function addWeek() {
    const next = weeks.length ? weeks[weeks.length - 1].weekNumber + 1 : 1;
    setWeeks((prev) => [
      ...prev,
      {
        weekNumber: next,
        rangeLabel: "—",
        scheduled: false,
        completed: false,
        notes: "",
        isCurrent: false,
        isFuture: true,
        scan: null,
      },
    ]);
  }

  const scheduledCount = weeks.filter((w) => w.scheduled).length;
  const completedCount = weeks.filter((w) => w.completed).length;

  return (
    <div className="space-y-4">
      <div className="card-pad">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <label className="label" htmlFor="signed-date">
              Week 1 start date
            </label>
            <input
              id="signed-date"
              type="date"
              className="input w-44"
              value={signed}
              disabled={!canEdit}
              // Save on change as well as blur: picking a date from the native
              // calendar and then clicking straight into the grid used to save
              // only on blur, which made the control look inert.
              onChange={(e) => {
                setSigned(e.target.value);
                if ((e.target.value || "") !== (signedDate ?? "")) {
                  saveSignedDate(e.target.value);
                }
              }}
              onBlur={(e) => {
                if ((e.target.value || "") !== (signedDate ?? "")) {
                  saveSignedDate(e.target.value);
                }
              }}
            />
            <p className="text-xs text-slate-400 mt-1">
              The program&apos;s week 1 (the signed date). If unset, weeks count
              from the first payment.
            </p>
            {savedNote && <p className="text-xs text-green-600 mt-1">{savedNote}</p>}
          </div>
          <div className="flex gap-5 text-sm">
            <div>
              <div className="text-xs text-slate-500">Scheduled</div>
              <div className="text-lg font-semibold text-slate-900">
                {scheduledCount}
              </div>
            </div>
            <div>
              <div className="text-xs text-slate-500">Completed</div>
              <div className="text-lg font-semibold text-slate-900">
                {completedCount}
                <span className="text-slate-400 text-sm font-normal">
                  {" "}
                  / {scheduledCount || "—"}
                </span>
              </div>
            </div>
          </div>
        </div>
        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2 mt-3">
            {error}
          </div>
        )}
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th className="w-40">Week</th>
                <th className="text-center w-24">Scheduled</th>
                <th className="text-center w-24">Completed</th>
                <th>Progress notes</th>
                <th className="w-52">InBody scan</th>
              </tr>
            </thead>
            <tbody>
              {weeks.map((w) => (
                <tr
                  key={w.weekNumber}
                  className={w.isCurrent ? "bg-indigo-50/40" : undefined}
                >
                  <td>
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-900">
                        Week {w.weekNumber}
                      </span>
                      {w.isCurrent && (
                        <span className="badge-green text-[10px]">current</span>
                      )}
                    </div>
                    <div className="text-xs text-slate-400">{w.rangeLabel}</div>
                  </td>
                  <td className="text-center">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-indigo-600 cursor-pointer disabled:cursor-default"
                      checked={w.scheduled}
                      disabled={!canEdit || savingWeek === w.weekNumber}
                      onChange={(e) =>
                        saveWeek(w.weekNumber, { scheduled: e.target.checked })
                      }
                      aria-label={`Week ${w.weekNumber} scheduled`}
                    />
                  </td>
                  <td className="text-center">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-green-600 cursor-pointer disabled:cursor-default"
                      checked={w.completed}
                      disabled={!canEdit || savingWeek === w.weekNumber}
                      onChange={(e) =>
                        saveWeek(w.weekNumber, { completed: e.target.checked })
                      }
                      aria-label={`Week ${w.weekNumber} completed`}
                    />
                  </td>
                  <td>
                    <NotesCell
                      value={w.notes}
                      disabled={!canEdit}
                      onSave={(notes) => saveWeek(w.weekNumber, { notes })}
                    />
                  </td>
                  <td className="text-xs">
                    {w.scan ? (
                      <div>
                        <span className="font-medium text-slate-700">
                          {w.scan.dateLabel}
                        </span>
                        <div className="text-slate-500">{w.scan.summary}</div>
                      </div>
                    ) : (
                      <span className="text-slate-300">no scan</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {canEdit && (
          <div className="border-t border-line px-4 py-2">
            <button
              className="text-xs text-indigo-600 hover:underline"
              onClick={addWeek}
            >
              + Add week {weeks.length ? weeks[weeks.length - 1].weekNumber + 1 : 1}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function NotesCell({
  value,
  disabled,
  onSave,
}: {
  value: string;
  disabled: boolean;
  onSave: (v: string) => void;
}) {
  const [text, setText] = useState(value);
  return (
    <textarea
      className="input min-h-[2.2rem] text-sm resize-y w-full"
      rows={1}
      maxLength={5000}
      placeholder={disabled ? "" : "Add a note…"}
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== value) onSave(text);
      }}
    />
  );
}
