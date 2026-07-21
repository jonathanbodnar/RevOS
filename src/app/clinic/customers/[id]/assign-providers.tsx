"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function AssignProviders({
  customerId,
  providers,
  assignedIds,
}: {
  customerId: string;
  providers: { id: string; label: string }[];
  assignedIds: string[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set(assignedIds));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (providers.length === 0) {
    return (
      <div className="card-pad">
        <h3 className="text-sm font-semibold text-slate-900 mb-1">Providers</h3>
        <p className="text-xs text-slate-400">
          No providers in this clinic yet. Add them under Users.
        </p>
      </div>
    );
  }

  async function save(next: Set<string>) {
    setError(null);
    setBusy(true);
    const res = await fetch(`/api/clinic/customers/${customerId}/providers`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerIds: [...next] }),
    });
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Could not update.");
      // roll back to server truth
      startTransition(() => router.refresh());
      return;
    }
    startTransition(() => router.refresh());
  }

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
    save(next);
  }

  return (
    <div className="card-pad">
      <h3 className="text-sm font-semibold text-slate-900 mb-1">Providers</h3>
      <p className="text-xs text-slate-400 mb-3">
        Assigned providers can chart and view this patient.
      </p>
      <div className="space-y-1.5">
        {providers.map((p) => (
          <label
            key={p.id}
            className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer"
          >
            <input
              type="checkbox"
              className="h-4 w-4 accent-indigo-600"
              checked={selected.has(p.id)}
              disabled={busy}
              onChange={() => toggle(p.id)}
            />
            {p.label}
          </label>
        ))}
      </div>
      {error && <div className="text-xs text-red-600 mt-2">{error}</div>}
    </div>
  );
}
