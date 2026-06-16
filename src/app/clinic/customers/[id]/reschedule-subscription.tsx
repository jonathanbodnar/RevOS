"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function RescheduleSubscriptionButton({
  subscriptionId,
  currentNextPaymentOn,
}: {
  subscriptionId: string;
  // ISO string or null — used to seed the date picker.
  currentNextPaymentOn: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState(() => toDateInput(currentNextPaymentOn));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const res = await fetch(
      `/api/clinic/subscriptions/${subscriptionId}/reschedule`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nextPaymentOn: date }),
      },
    );
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Failed to reschedule.");
      return;
    }
    setOpen(false);
    startTransition(() => router.refresh());
  }

  return (
    <>
      <button
        className="btn-ghost text-xs px-2 py-1"
        onClick={() => {
          setError(null);
          setDate(toDateInput(currentNextPaymentOn));
          setOpen(true);
        }}
        disabled={busy || pending}
      >
        Reschedule
      </button>

      {open && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) setOpen(false);
          }}
        >
          <div className="card-pad max-w-sm w-full text-left">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-semibold text-slate-900">
                Reschedule subscription
              </h2>
              <button
                className="btn-ghost p-1 text-slate-400 hover:text-slate-600"
                onClick={() => !busy && setOpen(false)}
                aria-label="Close"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <p className="text-xs text-slate-500 mb-4">
              Move the next charge / renewal to a new date. The customer is not
              charged now — the recurring schedule simply continues from this
              date.
            </p>

            <form onSubmit={submit} className="space-y-4">
              <div>
                <label className="label">Next payment date</label>
                <input
                  type="date"
                  className="input"
                  value={date}
                  min={todayInput()}
                  onChange={(e) => setDate(e.target.value)}
                  required
                />
              </div>

              {error && (
                <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
                  {error}
                </div>
              )}

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn-secondary flex-1"
                  onClick={() => !busy && setOpen(false)}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary flex-1"
                  disabled={busy || !date}
                >
                  {busy ? "Saving…" : "Reschedule"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

function toDateInput(iso: string | null): string {
  if (!iso) return todayInput();
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return todayInput();
  return d.toISOString().slice(0, 10);
}

function todayInput(): string {
  return new Date().toISOString().slice(0, 10);
}
