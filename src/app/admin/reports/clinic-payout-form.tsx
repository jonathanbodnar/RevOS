"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function ClinicPayoutForm({
  clinics,
  defaultClinicId,
}: {
  clinics: { id: string; name: string }[];
  defaultClinicId?: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [clinicId, setClinicId] = useState(defaultClinicId || clinics[0]?.id || "");
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const res = await fetch("/api/admin/clinic-payouts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clinicId, amount, paidOn, note: note || undefined }),
    });
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Failed to log payout.");
      return;
    }
    setAmount("");
    setNote("");
    setOpen(false);
    startTransition(() => router.refresh());
  }

  if (!open) {
    return (
      <button className="btn-secondary text-xs print-hidden" onClick={() => setOpen(true)}>
        + Log payout
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="card-pad space-y-3 print-hidden">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="label">Clinic</label>
          <select className="input" value={clinicId} onChange={(e) => setClinicId(e.target.value)}>
            {clinics.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">Amount paid (USD)</label>
          <input
            className="input"
            required
            inputMode="decimal"
            placeholder="1500.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Date paid</label>
          <input type="date" className="input" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
        </div>
        <div>
          <label className="label">Note (optional)</label>
          <input
            className="input"
            placeholder="ACH ref / check #"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>
      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
          {error}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-ghost text-sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button className="btn-primary text-sm" disabled={busy}>
          {busy ? "Logging…" : "Log payout"}
        </button>
      </div>
    </form>
  );
}
