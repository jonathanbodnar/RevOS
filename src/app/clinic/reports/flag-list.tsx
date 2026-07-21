"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type Flag = {
  id: string;
  kpiName: string;
  severity: string;
  detail: string | null;
  customerId: string;
  customerName: string;
  createdAt: string;
};

export function FlagList({ flags }: { flags: Flag[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

  async function act(id: string, status: "resolved" | "dismissed") {
    setBusy(id);
    const res = await fetch(`/api/clinic/kpi-flags/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setBusy(null);
    if (res.ok) startTransition(() => router.refresh());
  }

  if (flags.length === 0) {
    return (
      <div className="card-pad text-center text-slate-500 py-12">
        <p className="text-sm">No open flags. Everyone&apos;s on track. 🎉</p>
      </div>
    );
  }

  return (
    <div className="card overflow-hidden">
      <table className="table">
        <thead>
          <tr>
            <th>Patient</th>
            <th>KPI</th>
            <th>Detail</th>
            <th className="text-right pr-4">Actions</th>
          </tr>
        </thead>
        <tbody>
          {flags.map((f) => (
            <tr key={f.id}>
              <td>
                <Link
                  href={`/clinic/customers/${f.customerId}`}
                  className="text-brand-600 hover:underline font-medium"
                >
                  {f.customerName}
                </Link>
              </td>
              <td>
                <span
                  className={
                    f.severity === "critical"
                      ? "badge-red"
                      : f.severity === "warn"
                        ? "badge-yellow"
                        : "badge-slate"
                  }
                >
                  {f.kpiName}
                </span>
              </td>
              <td className="text-slate-600 text-xs">{f.detail || "—"}</td>
              <td className="text-right pr-4 whitespace-nowrap">
                <button
                  className="text-xs text-green-700 hover:underline"
                  disabled={busy === f.id}
                  onClick={() => act(f.id, "resolved")}
                >
                  Resolve
                </button>
                <button
                  className="text-xs text-slate-500 hover:underline ml-3"
                  disabled={busy === f.id}
                  onClick={() => act(f.id, "dismissed")}
                >
                  Dismiss
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
