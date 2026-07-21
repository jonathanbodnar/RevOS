"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function MoveClinicButton({
  customerId,
  customerName,
  currentClinicName,
  clinics,
}: {
  customerId: string;
  customerName: string;
  currentClinicName: string;
  clinics: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (clinics.length === 0) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    setError(null);
    setBusy(true);
    const res = await fetch(`/api/admin/customers/${customerId}/move-clinic`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clinicId: target }),
    });
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Failed to move patient.");
      return;
    }
    setOpen(false);
    // The profile is no longer reachable under the current clinic context
    // (the page queries by session clinic id), so return to the list instead
    // of refreshing into a 404.
    startTransition(() => router.push("/clinic/customers"));
  }

  return (
    <>
      <button
        className="btn-secondary text-xs"
        onClick={() => {
          setError(null);
          setTarget("");
          setOpen(true);
        }}
        disabled={pending}
      >
        Move clinic
      </button>

      {open && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) setOpen(false);
          }}
        >
          <div className="card-pad max-w-md w-full text-left">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-semibold text-slate-900">
                Move patient to another clinic
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
              Move <span className="font-medium text-slate-700">{customerName}</span>{" "}
              out of <span className="font-medium text-slate-700">{currentClinicName}</span>.
              All transactions, subscriptions, installment plans, care credits and
              InBody scans move with the patient, so reporting and clinic balances
              follow them to the new clinic —{" "}
              <span className="font-medium text-slate-700">
                including revenue already collected
              </span>
              . If {currentClinicName} was already paid out for this
              patient&apos;s history, adjust its payouts in the reporting center
              afterward.
            </p>

            <form onSubmit={submit} className="space-y-4">
              <div>
                <label className="label">Destination clinic</label>
                <select
                  className="input"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  <option value="">Select a clinic…</option>
                  {clinics.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
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
                  disabled={busy || !target}
                >
                  {busy ? "Moving…" : "Move patient"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
