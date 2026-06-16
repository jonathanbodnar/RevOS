"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function MergeCustomerButton({
  customerId,
  otherCustomers,
}: {
  customerId: string;
  otherCustomers: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (otherCustomers.length === 0) return null;

  const filtered = query.trim()
    ? otherCustomers.filter((c) =>
        c.label.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : otherCustomers;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!source) return;
    setError(null);
    setBusy(true);
    const res = await fetch(`/api/clinic/customers/${customerId}/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceCustomerId: source }),
    });
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Failed to merge.");
      return;
    }
    setOpen(false);
    startTransition(() => router.refresh());
  }

  return (
    <>
      <button
        className="btn-secondary text-xs"
        onClick={() => {
          setError(null);
          setQuery("");
          setSource("");
          setOpen(true);
        }}
        disabled={pending}
      >
        Merge profile
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
                Merge another profile in
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
              Move all cards, transactions, subscriptions, installment plans and
              care credits from the selected duplicate into{" "}
              <span className="font-medium text-slate-700">this profile</span>.
              The duplicate is then permanently deleted. This can&apos;t be undone.
            </p>

            <form onSubmit={submit} className="space-y-4">
              <div>
                <label className="label">Duplicate profile to merge in</label>
                <input
                  className="input mb-2"
                  placeholder="Name or email…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <select
                  className="input"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  size={6}
                >
                  {filtered.length === 0 && <option disabled>No matches</option>}
                  {filtered.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
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
                  disabled={busy || !source}
                >
                  {busy ? "Merging…" : "Merge & delete duplicate"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
