"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

const METRICS = [
  { value: "visit_adherence_pct", label: "Visit adherence (%)" },
  { value: "days_since_last_charge", label: "Days since last charge" },
  { value: "weeks_since_last_scan", label: "Weeks since last InBody scan" },
  { value: "body_fat_pct_change", label: "Body-fat % change" },
  { value: "weight_change_kg", label: "Weight change (kg)" },
];
const METRIC_LABEL = Object.fromEntries(METRICS.map((m) => [m.value, m.label]));
const COMPARISONS = [
  { value: "lt", label: "is below (<)" },
  { value: "lte", label: "is at or below (≤)" },
  { value: "gt", label: "is above (>)" },
  { value: "gte", label: "is at or above (≥)" },
];
const COMP_SYM: Record<string, string> = { lt: "<", lte: "≤", gt: ">", gte: "≥" };

type KpiRow = {
  id: string;
  name: string;
  metric: string;
  comparison: string;
  threshold: number;
  windowDays: number;
  severity: string;
  isActive: boolean;
  clinicName: string | null;
  openFlags: number;
};

export function KpisClient({
  kpis,
  clinics,
}: {
  kpis: KpiRow[];
  clinics: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [form, setForm] = useState({
    name: "",
    metric: "visit_adherence_pct",
    comparison: "lt",
    threshold: "80",
    windowDays: "0",
    severity: "warn",
    clinicId: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const res = await fetch("/api/admin/kpis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, clinicId: form.clinicId || null }),
    });
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Could not create KPI.");
      return;
    }
    setForm({ ...form, name: "", threshold: "80" });
    startTransition(() => router.refresh());
  }

  async function toggle(k: KpiRow) {
    const res = await fetch(`/api/admin/kpis/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !k.isActive }),
    });
    if (res.ok) startTransition(() => router.refresh());
  }
  async function remove(k: KpiRow) {
    const res = await fetch(`/api/admin/kpis/${k.id}`, { method: "DELETE" });
    if (res.ok) startTransition(() => router.refresh());
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <form onSubmit={create} className="card-pad space-y-3 h-fit">
        <h3 className="text-sm font-semibold text-slate-900">Add a KPI</h3>
        <div>
          <label className="label">Name</label>
          <input
            className="input"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="e.g. Low visit adherence"
            required
          />
        </div>
        <div>
          <label className="label">Metric</label>
          <select
            className="input"
            value={form.metric}
            onChange={(e) => setForm({ ...form, metric: e.target.value })}
          >
            {METRICS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">Flag when</label>
            <select
              className="input"
              value={form.comparison}
              onChange={(e) => setForm({ ...form, comparison: e.target.value })}
            >
              {COMPARISONS.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Threshold</label>
            <input
              type="number"
              step="any"
              className="input"
              value={form.threshold}
              onChange={(e) => setForm({ ...form, threshold: e.target.value })}
              required
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="label">Window (days)</label>
            <input
              type="number"
              min="0"
              className="input"
              value={form.windowDays}
              onChange={(e) => setForm({ ...form, windowDays: e.target.value })}
            />
            <p className="text-[11px] text-slate-400 mt-0.5">0 = whole program</p>
          </div>
          <div>
            <label className="label">Severity</label>
            <select
              className="input"
              value={form.severity}
              onChange={(e) => setForm({ ...form, severity: e.target.value })}
            >
              <option value="info">Info</option>
              <option value="warn">Warn</option>
              <option value="critical">Critical</option>
            </select>
          </div>
        </div>
        <div>
          <label className="label">Scope</label>
          <select
            className="input"
            value={form.clinicId}
            onChange={(e) => setForm({ ...form, clinicId: e.target.value })}
          >
            <option value="">All clinics (global)</option>
            {clinics.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
            {error}
          </div>
        )}
        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? "Creating…" : "Create KPI"}
        </button>
      </form>

      <div className="lg:col-span-2 card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>KPI</th>
                <th>Rule</th>
                <th>Scope</th>
                <th>Open flags</th>
                <th className="text-right pr-4">·</th>
              </tr>
            </thead>
            <tbody>
              {kpis.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-slate-500 py-10">
                    No KPIs yet.
                  </td>
                </tr>
              )}
              {kpis.map((k) => (
                <tr key={k.id} className={k.isActive ? undefined : "opacity-60"}>
                  <td className="font-medium text-slate-900">
                    {k.name}
                    <div className="text-xs text-slate-400">
                      {k.severity}
                      {!k.isActive && " · inactive"}
                    </div>
                  </td>
                  <td className="text-xs text-slate-600">
                    {METRIC_LABEL[k.metric] ?? k.metric} {COMP_SYM[k.comparison]}{" "}
                    {k.threshold}
                    {k.windowDays > 0 ? ` · ${k.windowDays}d` : ""}
                  </td>
                  <td className="text-slate-600">{k.clinicName ?? "Global"}</td>
                  <td>
                    {k.openFlags > 0 ? (
                      <span className="badge-red">{k.openFlags}</span>
                    ) : (
                      <span className="text-slate-400">0</span>
                    )}
                  </td>
                  <td className="text-right pr-4 whitespace-nowrap">
                    <button
                      className="text-xs text-slate-500 hover:underline"
                      onClick={() => toggle(k)}
                    >
                      {k.isActive ? "Pause" : "Resume"}
                    </button>
                    <button
                      className="text-xs text-red-500 hover:underline ml-3"
                      onClick={() => remove(k)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
