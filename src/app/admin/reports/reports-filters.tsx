"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

type Option = { id: string; name: string };

const PRESETS: { id: string; label: string }[] = [
  { id: "mtd", label: "Month to date" },
  { id: "last_month", label: "Last month" },
  { id: "ytd", label: "Year to date" },
  { id: "range", label: "Custom range" },
  { id: "all", label: "All time" },
];

export function ReportsFilters({
  clinics,
  implementors,
  current,
}: {
  clinics: Option[];
  implementors: Option[];
  current: {
    preset: string;
    from: string;
    to: string;
    clinicId: string;
    implementorId: string;
  };
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [from, setFrom] = useState(current.from);
  const [to, setTo] = useState(current.to);

  function navigate(updates: Record<string, string>) {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    router.push(`/admin/reports?${next.toString()}`);
  }

  return (
    <div className="card-pad space-y-4 print-hidden">
      <div className="flex flex-wrap gap-2">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => navigate({ preset: p.id })}
            className={
              current.preset === p.id
                ? "btn-primary text-xs"
                : "btn-secondary text-xs"
            }
          >
            {p.label}
          </button>
        ))}
      </div>

      {current.preset === "range" && (
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="label">From</label>
            <input
              type="date"
              className="input"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div>
            <label className="label">To</label>
            <input
              type="date"
              className="input"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          <button
            className="btn-secondary text-xs"
            onClick={() => navigate({ preset: "range", from, to })}
          >
            Apply range
          </button>
        </div>
      )}

      <div className="flex flex-wrap gap-3">
        <div className="min-w-[200px]">
          <label className="label">Clinic</label>
          <select
            className="input"
            value={current.clinicId}
            onChange={(e) => navigate({ clinicId: e.target.value })}
          >
            <option value="">All clinics</option>
            {clinics.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-[200px]">
          <label className="label">Implementor</label>
          <select
            className="input"
            value={current.implementorId}
            onChange={(e) => navigate({ implementorId: e.target.value })}
          >
            <option value="">All implementors</option>
            {implementors.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
