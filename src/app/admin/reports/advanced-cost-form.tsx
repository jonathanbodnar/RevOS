"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function AdvancedCostForm({
  clinics,
}: {
  clinics: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [clinicId, setClinicId] = useState(clinics[0]?.id ?? "");
  const [category, setCategory] = useState("supplements");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [incurredOn, setIncurredOn] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const res = await fetch("/api/admin/advanced-costs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clinicId,
        category,
        description,
        amount,
        incurredOn: incurredOn || undefined,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Failed to add cost.");
      return;
    }
    setDescription("");
    setAmount("");
    setOpen(false);
    startTransition(() => router.refresh());
  }

  if (!open) {
    return (
      <button className="btn-secondary text-xs print-hidden" onClick={() => setOpen(true)}>
        + Add advanced cost
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
          <label className="label">Category</label>
          <select className="input" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="supplements">Supplements</option>
            <option value="booklets">Booklets</option>
            <option value="other">Other</option>
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="label">Description</label>
          <input
            className="input"
            required
            placeholder="90 days supplements for patient / 200 weight-loss booklets"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Amount (USD)</label>
          <input
            className="input"
            required
            inputMode="decimal"
            placeholder="450.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Date incurred</label>
          <input type="date" className="input" value={incurredOn} onChange={(e) => setIncurredOn(e.target.value)} />
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
          {busy ? "Adding…" : "Add cost"}
        </button>
      </div>
    </form>
  );
}
