"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { formatMoneyCents } from "@/lib/format";

type Implementor = {
  id: string;
  name: string;
  commissionCents: number;
  isActive: boolean;
  customerCount: number;
};

export function ImplementorsClient({
  implementors,
}: {
  implementors: Implementor[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [commission, setCommission] = useState("140.00");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const res = await fetch("/api/admin/implementors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        commissionCents: Math.round(parseFloat(commission || "0") * 100),
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Failed to add implementor.");
      return;
    }
    setName("");
    setCommission("140.00");
    startTransition(() => router.refresh());
  }

  async function patch(id: string, body: Record<string, unknown>) {
    await fetch(`/api/admin/implementors/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    startTransition(() => router.refresh());
  }

  async function remove(id: string) {
    if (!confirm("Delete this implementor? Their customers keep their history.")) return;
    await fetch(`/api/admin/implementors/${id}`, { method: "DELETE" });
    startTransition(() => router.refresh());
  }

  return (
    <div className="space-y-6">
      <form onSubmit={add} className="card-pad flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[180px]">
          <label className="label">Name</label>
          <input
            className="input"
            required
            placeholder="Jane Implementor"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="w-40">
          <label className="label">Commission ($ / down payment)</label>
          <input
            className="input"
            inputMode="decimal"
            value={commission}
            onChange={(e) => setCommission(e.target.value)}
          />
        </div>
        <button className="btn-primary" disabled={busy}>
          {busy ? "Adding…" : "Add implementor"}
        </button>
        {error && (
          <div className="w-full text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
            {error}
          </div>
        )}
      </form>

      <div className="card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Commission</th>
              <th>Customers</th>
              <th>Status</th>
              <th className="text-right pr-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {implementors.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center text-slate-500 py-8">
                  No implementors yet.
                </td>
              </tr>
            )}
            {implementors.map((i) => (
              <tr key={i.id}>
                <td className="font-medium text-slate-900">{i.name}</td>
                <td>{formatMoneyCents(i.commissionCents)}</td>
                <td className="text-slate-600">{i.customerCount}</td>
                <td>
                  <span className={i.isActive ? "badge-green" : "badge-slate"}>
                    {i.isActive ? "active" : "inactive"}
                  </span>
                </td>
                <td className="text-right pr-3">
                  <div className="flex items-center justify-end gap-1">
                    <button
                      className="btn-ghost text-xs px-2 py-1"
                      onClick={() => {
                        const v = prompt("New commission ($ per down payment)", (i.commissionCents / 100).toFixed(2));
                        if (v === null) return;
                        const cents = Math.round(parseFloat(v) * 100);
                        if (!Number.isNaN(cents) && cents >= 0) patch(i.id, { commissionCents: cents });
                      }}
                    >
                      Edit fee
                    </button>
                    <button
                      className="btn-ghost text-xs px-2 py-1"
                      onClick={() => patch(i.id, { isActive: !i.isActive })}
                    >
                      {i.isActive ? "Deactivate" : "Activate"}
                    </button>
                    <button
                      className="btn-ghost text-red-600 hover:bg-red-50 text-xs px-2 py-1"
                      onClick={() => remove(i.id)}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
