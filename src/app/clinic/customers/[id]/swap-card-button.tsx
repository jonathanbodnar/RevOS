"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function SwapCardButton({
  subscriptionId,
  currentPaymentMethodId,
  methods,
}: {
  subscriptionId: string;
  currentPaymentMethodId: string | null;
  methods: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const others = methods.filter((m) => m.id !== currentPaymentMethodId);
  const [selected, setSelected] = useState(others[0]?.id ?? "");

  // Nothing to swap to.
  if (others.length === 0) return null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const res = await fetch(
      `/api/clinic/subscriptions/${subscriptionId}/swap-card`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentMethodId: selected }),
      },
    );
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Failed to swap card.");
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
          setSelected(others[0]?.id ?? "");
          setOpen(true);
        }}
        disabled={busy || pending}
      >
        Swap card
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
                Swap subscription card
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
              Future charges move to the selected card. The billing date stays
              the same — the customer is not charged now.
            </p>

            <form onSubmit={submit} className="space-y-4">
              <div>
                <label className="label">Charge future cycles to</label>
                <select
                  className="input"
                  value={selected}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  {others.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
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
                <button type="submit" className="btn-primary flex-1" disabled={busy || !selected}>
                  {busy ? "Swapping…" : "Swap card"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
