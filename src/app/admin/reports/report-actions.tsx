"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function ReportActions({
  filtersJson,
  csv,
  csvFilename,
  savedReports,
}: {
  filtersJson: string;
  csv: string;
  csvFilename: string;
  savedReports: { id: string; name: string; filtersJson: string }[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);

  function downloadCsv() {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = csvFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async function save() {
    const name = prompt("Name this report");
    if (!name) return;
    setSaving(true);
    await fetch("/api/admin/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, filtersJson }),
    });
    setSaving(false);
    startTransition(() => router.refresh());
  }

  async function remove(id: string) {
    if (!confirm("Delete this saved report?")) return;
    await fetch(`/api/admin/reports/${id}`, { method: "DELETE" });
    startTransition(() => router.refresh());
  }

  function loadReport(fJson: string) {
    try {
      const f = JSON.parse(fJson) as Record<string, string>;
      const next = new URLSearchParams();
      for (const [k, v] of Object.entries(f)) if (v) next.set(k, v);
      router.push(`/admin/reports?${next.toString()}`);
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 print-hidden">
      {savedReports.length > 0 && (
        <select
          className="input w-auto"
          defaultValue=""
          onChange={(e) => {
            const r = savedReports.find((x) => x.id === e.target.value);
            if (r) loadReport(r.filtersJson);
          }}
        >
          <option value="" disabled>
            Load saved report…
          </option>
          {savedReports.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      )}
      <button className="btn-secondary text-sm" onClick={save} disabled={saving}>
        {saving ? "Saving…" : "Save report"}
      </button>
      <button className="btn-secondary text-sm" onClick={downloadCsv}>
        Download CSV
      </button>
      <button className="btn-primary text-sm" onClick={() => window.print()}>
        Download PDF
      </button>
      {savedReports.length > 0 && (
        <details className="relative">
          <summary className="btn-ghost text-sm cursor-pointer list-none">
            Manage saved
          </summary>
          <div className="absolute right-0 z-10 mt-1 w-64 card-pad space-y-2 shadow-lg">
            {savedReports.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate">{r.name}</span>
                <button
                  className="text-xs text-red-600 hover:underline"
                  onClick={() => remove(r.id)}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
