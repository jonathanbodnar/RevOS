"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function CustomerAttribution({
  customerId,
  implementors,
  currentImplementorId,
  currentNotes,
}: {
  customerId: string;
  implementors: { id: string; name: string }[];
  currentImplementorId: string | null;
  currentNotes: string | null;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [implementorId, setImplementorId] = useState(currentImplementorId ?? "");
  const [notes, setNotes] = useState(currentNotes ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function save() {
    setSaving(true);
    setSaved(false);
    const res = await fetch(`/api/clinic/customers/${customerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        implementorId: implementorId || null,
        paymentNotes: notes || null,
      }),
    });
    setSaving(false);
    if (res.ok) {
      setSaved(true);
      startTransition(() => router.refresh());
    }
  }

  return (
    <div className="card-pad space-y-3">
      <h3 className="text-sm font-semibold text-slate-900">Attribution &amp; notes</h3>
      <div>
        <label className="label">Implementor</label>
        <select
          className="input"
          value={implementorId}
          onChange={(e) => {
            setImplementorId(e.target.value);
            setSaved(false);
          }}
        >
          <option value="">— None —</option>
          {implementors.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="label">Payment notes</label>
        <textarea
          className="input min-h-[64px]"
          placeholder="e.g. Paid down payment using Care Credit"
          value={notes}
          onChange={(e) => {
            setNotes(e.target.value);
            setSaved(false);
          }}
        />
      </div>
      <div className="flex items-center justify-between">
        {saved ? (
          <span className="text-xs text-emerald-600">Saved.</span>
        ) : (
          <span />
        )}
        <button className="btn-primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
