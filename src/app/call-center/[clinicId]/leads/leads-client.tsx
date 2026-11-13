"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatPhone } from "@/lib/phone";
import { STAGE_BADGE, STAGE_LABEL, STAGES, isStage } from "@/lib/call-center/stages";

type Row = {
  id: string;
  name: string;
  phone: string;
  stage: string;
  priority: boolean;
  attempts: number;
  callbackAt: string | null;
  apptAt: string | null;
  lastCalledAt: string | null;
  nextDueDay: string | null;
  consent: boolean;
  source: string | null;
};
type Page = { total: number; page: number; perPage: number; rows: Row[]; counts: Record<string, number> };

const short = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";

/** Every lead for this clinic. Click one to open it on the desk. */
export function LeadsClient({ clinicId }: { clinicId: string }) {
  const base = `/api/call-center/${clinicId}`;
  const [stage, setStage] = useState("all");
  const [q, setQ] = useState("");
  const [prio, setPrio] = useState(false);
  const [page, setPage] = useState(0);
  const [data, setData] = useState<Page | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ firstName: "", lastName: "", phone: "", email: "", note: "", priority: false, consent: false });
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const sp = new URLSearchParams();
    if (stage !== "all") sp.set("stage", stage);
    if (q.trim()) sp.set("q", q.trim());
    if (prio) sp.set("prio", "1");
    sp.set("page", String(page));
    const res = await fetch(`${base}/leads?${sp}`, { cache: "no-store" });
    const body = (await res.json().catch(() => ({}))) as { data?: Page };
    if (body.data) setData(body.data);
  }, [base, stage, q, prio, page]);

  useEffect(() => {
    const t = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(t);
  }, [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    const res = await fetch(`${base}/leads`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      setMsg(body.error || "Couldn't add that lead.");
      return;
    }
    setForm({ firstName: "", lastName: "", phone: "", email: "", note: "", priority: false, consent: false });
    setAdding(false);
    setMsg("Lead added. They're on the list as a new lead.");
    void load();
  }

  const total = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.perPage)) : 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <select className="input !w-auto" value={stage} onChange={(e) => { setStage(e.target.value); setPage(0); }} aria-label="Filter by status">
          <option value="all">All ({total.toLocaleString()})</option>
          {STAGES.filter((s) => data?.counts[s]).map((s) => (
            <option key={s} value={s}>
              {STAGE_LABEL[s]} ({(data?.counts[s] ?? 0).toLocaleString()})
            </option>
          ))}
        </select>
        <input className="input !w-64" type="search" placeholder="Name, number or email" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} aria-label="Search leads" />
        <label className="flex items-center gap-2 text-sm text-ink-muted">
          <input type="checkbox" checked={prio} onChange={(e) => { setPrio(e.target.checked); setPage(0); }} /> Priority only
        </label>
        <span className="text-xs text-ink-subtle">{data ? `${data.total.toLocaleString()} shown` : ""}</span>
        <span className="flex-1" />
        <button className="btn-secondary" onClick={() => setAdding((v) => !v)}>
          {adding ? "Close" : "Add a lead"}
        </button>
        <Link href={`/call-center/${clinicId}/import`} className="btn-primary">
          Import leads
        </Link>
      </div>

      {msg && <div className="text-sm text-ink bg-surface-alt rounded-lg px-4 py-2">{msg}</div>}

      {adding && (
        <form onSubmit={add} className="card-pad grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="label">First name</label>
            <input className="input" value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
          </div>
          <div>
            <label className="label">Last name</label>
            <input className="input" value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
          </div>
          <div>
            <label className="label">Mobile number</label>
            <input className="input" required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          </div>
          <div>
            <label className="label">Email</label>
            <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div className="md:col-span-2">
            <label className="label">Note</label>
            <input className="input" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" checked={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.checked })} /> Priority
          </label>
          <label className="flex items-center gap-2 text-sm text-ink md:col-span-2">
            <input type="checkbox" checked={form.consent} onChange={(e) => setForm({ ...form, consent: e.target.checked })} /> They agreed in writing to be called (allows auto-dial)
          </label>
          <div className="md:col-span-3">
            <button className="btn-primary" type="submit">
              Add lead
            </button>
          </div>
        </form>
      )}

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Status</th>
                <th>Tries</th>
                <th>Last called</th>
                <th>Next</th>
                <th>Consent</th>
              </tr>
            </thead>
            <tbody>
              {data?.rows.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-ink-muted">
                    No leads match. <Link className="btn-link" href={`/call-center/${clinicId}/import`}>Import leads</Link>
                  </td>
                </tr>
              )}
              {data?.rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/call-center/${clinicId}?open=${r.id}`} className="font-medium text-ink hover:underline">
                      {r.name}
                    </Link>
                    {r.priority && <span className="badge-yellow ml-2">P</span>}
                  </td>
                  <td className="tabular-nums text-ink-muted">{formatPhone(r.phone)}</td>
                  <td>
                    <span className={isStage(r.stage) ? STAGE_BADGE[r.stage] : "badge-slate"}>{isStage(r.stage) ? STAGE_LABEL[r.stage] : r.stage}</span>
                  </td>
                  <td className="tabular-nums">{r.attempts}</td>
                  <td className="text-ink-muted">{short(r.lastCalledAt)}</td>
                  <td className="text-ink-muted">
                    {r.stage === "nurture" && r.callbackAt ? short(r.callbackAt) : r.stage === "booked" && r.apptAt ? short(r.apptAt) : r.nextDueDay ?? "—"}
                  </td>
                  <td>{r.consent ? <span className="badge-green">Yes</span> : <span className="text-ink-subtle text-xs">No</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button className="btn-secondary" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
          Previous
        </button>
        <span className="text-xs text-ink-subtle">
          Page {page + 1} of {pages}
        </span>
        <button className="btn-secondary" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}
