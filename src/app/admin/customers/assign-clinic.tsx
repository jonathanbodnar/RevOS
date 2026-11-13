"use client";

import { useState } from "react";

export type ClinicOption = { id: string; name: string };

/**
 * Puts a patient (or just their records) with no clinic into one. These come
 * from a global payment link opened without the sharing clinic (`?c=`). Every
 * clinic page and every refund/cancel route is scoped to a clinic, so until
 * they have one, not even a super admin can open, refund, or cancel them. The
 * move-clinic route carries the billing history across.
 */
export function AssignClinic({
  customerId,
  clinics,
  defaultClinicId,
  onAssigned,
}: {
  customerId: string;
  clinics: ClinicOption[];
  defaultClinicId?: string | null;
  onAssigned: (clinicId: string) => Promise<void>;
}) {
  const [target, setTarget] = useState(defaultClinicId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function assign() {
    if (!target) return;
    setError(null);
    setBusy(true);
    const res = await fetch(`/api/admin/customers/${customerId}/move-clinic`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clinicId: target }),
    });
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Failed to assign clinic.");
      setBusy(false);
      return;
    }
    await onAssigned(target);
    setBusy(false);
  }

  return (
    <div className="inline-flex flex-col gap-1">
      <div className="inline-flex items-center gap-1.5">
        <select
          className="input text-xs py-1 min-w-[9rem]"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          disabled={busy}
          aria-label="Assign clinic"
        >
          <option value="">Assign clinic…</option>
          {clinics.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn-secondary text-xs whitespace-nowrap"
          disabled={!target || busy}
          onClick={assign}
        >
          {busy ? "Assigning…" : "Assign & open"}
        </button>
      </div>
      {error && <div className="text-xs text-red-600">{error}</div>}
    </div>
  );
}
