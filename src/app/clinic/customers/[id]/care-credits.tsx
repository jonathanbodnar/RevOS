"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type CareCreditView = {
  id: string;
  amountCents: number;
  collectedOn: string; // ISO
  note: string | null;
  source: string;
};

function fmt(cents: number) {
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function CareCredits({
  customerId,
  entries,
}: {
  customerId: string;
  entries: CareCreditView[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const res = await fetch(`/api/clinic/customers/${customerId}/care-credits`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount, collectedOn: date, note: note || undefined }),
    });
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Failed to log care credit.");
      return;
    }
    setAmount("");
    setNote("");
    startTransition(() => router.refresh());
  }

  async function remove(id: string) {
    if (!confirm("Delete this care credit entry?")) return;
    const res = await fetch(
      `/api/clinic/customers/${customerId}/care-credits/${id}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      alert("Failed to delete.");
      return;
    }
    startTransition(() => router.refresh());
  }

  const total = entries.reduce((s, e) => s + e.amountCents, 0);

  return (
    <div className="card-pad">
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-sm font-semibold text-slate-900">Care credit</h3>
        {total > 0 && (
          <span className="text-xs text-slate-500">{fmt(total)} logged</span>
        )}
      </div>
      <p className="text-xs text-slate-500 mb-3">
        Payments the patient made to the clinic via external financing. Not
        charged here — logged for reporting (split like a down payment).
      </p>

      {entries.length > 0 && (
        <ul className="divide-y divide-slate-100 mb-4">
          {entries.map((e) => (
            <li key={e.id} className="flex items-center justify-between py-2">
              <div>
                <div className="text-sm font-medium text-slate-900">
                  {fmt(e.amountCents)}
                  {e.source === "master_link" && (
                    <span className="badge-slate ml-2 text-[10px]">via link</span>
                  )}
                </div>
                <div className="text-xs text-slate-500">
                  {new Date(e.collectedOn).toLocaleDateString("en-US")}
                  {e.note ? ` · ${e.note}` : ""}
                </div>
              </div>
              <button
                className="btn-ghost text-red-600 hover:bg-red-50 text-xs"
                disabled={pending}
                onClick={() => remove(e.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={add} className="space-y-2 border-t border-slate-100 pt-3">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">Amount</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">$</span>
              <input
                className="input pl-7"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </div>
          <div>
            <label className="label">Date collected</label>
            <input
              type="date"
              className="input"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
        </div>
        <div>
          <label className="label">Note (optional)</label>
          <input
            className="input"
            placeholder="e.g. CareCredit 12-mo financing"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
            {error}
          </div>
        )}
        <button type="submit" className="btn-primary w-full" disabled={busy || !amount}>
          {busy ? "Logging…" : "Log care credit"}
        </button>
      </form>
    </div>
  );
}
