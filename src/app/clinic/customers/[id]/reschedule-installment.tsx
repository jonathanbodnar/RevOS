"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type PendingPayment = { amount: number; date: string; status: string };

export function RescheduleInstallmentButton({
  scheduleId,
}: {
  scheduleId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<PendingPayment[]>([]);

  async function openModal() {
    setError(null);
    setOpen(true);
    setLoading(true);
    const res = await fetch(`/api/clinic/schedules/${scheduleId}`);
    setLoading(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Failed to load installments.");
      return;
    }
    const d = (await res.json()) as { data: { payments: PendingPayment[] } };
    setRows(d.data.payments.filter((p) => p.status === "pending"));
  }

  function setDate(i: number, date: string) {
    setRows((prev) => prev.map((r, idx) => (idx === i ? { ...r, date } : r)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const res = await fetch(
      `/api/clinic/schedules/${scheduleId}/reschedule`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payments: rows.map((r) => ({ amount: r.amount, date: r.date })),
        }),
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

  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <button
        className="btn-ghost text-xs px-2 py-1"
        onClick={openModal}
        disabled={pending}
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
                Reschedule installment
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

            {loading ? (
              <p className="text-sm text-slate-500 py-4">Loading…</p>
            ) : rows.length === 0 ? (
              <p className="text-sm text-slate-500 py-4">
                {error || "No upcoming payments to reschedule."}
              </p>
            ) : (
              <form onSubmit={submit} className="space-y-4">
                <p className="text-xs text-slate-500">
                  Pick new dates for the upcoming payments. Already-collected
                  payments aren&apos;t affected.
                </p>
                {rows.map((r, i) => (
                  <div key={i}>
                    <label className="label">
                      Payment {i + 1} · ${(r.amount / 100).toFixed(2)}
                    </label>
                    <input
                      type="date"
                      className="input"
                      value={r.date}
                      min={today}
                      onChange={(e) => setDate(i, e.target.value)}
                      required
                    />
                  </div>
                ))}

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
                  <button type="submit" className="btn-primary flex-1" disabled={busy}>
                    {busy ? "Saving…" : "Save dates"}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
