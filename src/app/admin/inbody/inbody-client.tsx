"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { formatDate } from "@/lib/format";
import { formatPhone } from "@/lib/phone";
import { coreMetrics, segmentalMetrics, type InBodyTestRow } from "@/lib/inbody-display";

type Test = InBodyTestRow & {
  id: string;
  testedAt: string | null;
  equip: string | null;
  phone: string | null;
  account: string | null;
  matchStatus: string;
  resultStatus: string;
  fetchError: string | null;
  customer: { id: string; name: string } | null;
  clinicName: string | null;
};

type SearchResult = {
  id: string;
  label: string;
  email: string | null;
  phone: string | null;
  clinic: string | null;
};

export function InBodyClient({
  tests,
  webhookUrl,
  canFetch,
  onlyUnmatched,
}: {
  tests: Test[];
  webhookUrl: string;
  canFetch: boolean;
  onlyUnmatched: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [mapFor, setMapFor] = useState<Test | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [conn, setConn] = useState<string | null>(null);

  async function testConnection() {
    setConn("Testing…");
    const res = await fetch("/api/admin/inbody/connection-test", { method: "POST" });
    const d = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      status?: number;
      body?: string;
    };
    setConn(
      d.ok
        ? `Success (HTTP ${d.status})`
        : `Failed (HTTP ${d.status ?? "?"}): ${d.body || "no response"}`,
    );
  }

  async function refetch(id: string) {
    setBusyId(id);
    await fetch(`/api/admin/inbody/tests/${id}/refetch`, { method: "POST" });
    setBusyId(null);
    startTransition(() => router.refresh());
  }

  async function unmap(id: string) {
    if (!confirm("Remove the customer mapping for this test?")) return;
    setBusyId(id);
    await fetch(`/api/admin/inbody/tests/${id}/map`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerId: null }),
    });
    setBusyId(null);
    startTransition(() => router.refresh());
  }

  return (
    <div className="space-y-4">
      <div className="card-pad space-y-2">
        <div className="text-sm font-semibold text-slate-900">Webhook setup</div>
        <p className="text-xs text-slate-500">
          In LookinBody Web → API Setup → Webhook, enter this URL. Optionally add
          a security header whose value matches <code>INBODY_WEBHOOK_SECRET</code>.
        </p>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-xs bg-slate-50 border border-slate-200 rounded px-2 py-1.5 break-all">
            {webhookUrl}
          </code>
          <button
            className="btn-ghost text-xs px-2 py-1"
            onClick={() => navigator.clipboard?.writeText(webhookUrl)}
          >
            Copy
          </button>
        </div>
        <div className="flex items-center gap-3 pt-1">
          <button className="btn-ghost text-xs px-2 py-1" onClick={testConnection}>
            Test API connection
          </button>
          {conn && <span className="text-xs text-slate-600">{conn}</span>}
        </div>
        {!canFetch && (
          <p className="text-xs text-amber-600">
            Metrics fetch is not active yet — set <code>INBODY_DATA_FUNCTION</code>{" "}
            once InBody provides the data-endpoint in their developer docs.
            Notifications and phone auto-pairing already work.
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 text-sm">
        <Link
          href="/admin/inbody"
          className={onlyUnmatched ? "btn-ghost px-3 py-1" : "btn-primary px-3 py-1"}
        >
          All
        </Link>
        <Link
          href="/admin/inbody?filter=unmatched"
          className={onlyUnmatched ? "btn-primary px-3 py-1" : "btn-ghost px-3 py-1"}
        >
          Unmatched
        </Link>
      </div>

      <div className="card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>Tested</th>
              <th>Phone</th>
              <th>Customer</th>
              <th>Weight / BMI / PBF</th>
              <th>Status</th>
              <th className="text-right pr-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {tests.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-slate-500 py-8">
                  No InBody tests yet.
                </td>
              </tr>
            )}
            {tests.map((t) => (
              <FragmentRow
                key={t.id}
                t={t}
                expanded={expanded === t.id}
                busy={busyId === t.id}
                onToggle={() => setExpanded(expanded === t.id ? null : t.id)}
                onMap={() => setMapFor(t)}
                onUnmap={() => unmap(t.id)}
                onRefetch={() => refetch(t.id)}
                canFetch={canFetch}
              />
            ))}
          </tbody>
        </table>
      </div>

      {mapFor && (
        <MapModal
          test={mapFor}
          onClose={() => setMapFor(null)}
          onMapped={() => {
            setMapFor(null);
            startTransition(() => router.refresh());
          }}
        />
      )}
    </div>
  );
}

function FragmentRow({
  t,
  expanded,
  busy,
  onToggle,
  onMap,
  onUnmap,
  onRefetch,
  canFetch,
}: {
  t: Test;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onMap: () => void;
  onUnmap: () => void;
  onRefetch: () => void;
  canFetch: boolean;
}) {
  const core = coreMetrics(t);
  const summary = `${core[0].value} / ${core[5].value} / ${core[6].value}`;
  return (
    <>
      <tr>
        <td className="text-slate-600 text-xs">
          {t.testedAt ? formatDate(t.testedAt) : "—"}
          {t.equip && <div className="text-slate-400">{t.equip}</div>}
        </td>
        <td className="text-slate-600 text-xs">{formatPhone(t.phone)}</td>
        <td>
          {t.customer ? (
            <Link
              href={`/clinic/customers/${t.customer.id}`}
              className="text-indigo-600 hover:underline text-sm"
            >
              {t.customer.name}
            </Link>
          ) : (
            <span className="badge-yellow">unmatched</span>
          )}
          {t.clinicName && (
            <div className="text-xs text-slate-400">{t.clinicName}</div>
          )}
        </td>
        <td className="text-slate-600 text-xs">{summary}</td>
        <td>
          <ResultBadge status={t.resultStatus} />
          {t.matchStatus === "ambiguous" && (
            <div className="text-xs text-amber-600 mt-0.5">multiple phone matches</div>
          )}
        </td>
        <td className="text-right pr-3">
          <div className="flex items-center justify-end gap-1">
            <button className="btn-ghost text-xs px-2 py-1" onClick={onToggle}>
              {expanded ? "Hide" : "Details"}
            </button>
            {t.customer ? (
              <button className="btn-ghost text-xs px-2 py-1" onClick={onUnmap} disabled={busy}>
                Unmap
              </button>
            ) : (
              <button className="btn-ghost text-xs px-2 py-1" onClick={onMap} disabled={busy}>
                Map
              </button>
            )}
            {canFetch && (
              <button className="btn-ghost text-xs px-2 py-1" onClick={onRefetch} disabled={busy}>
                {busy ? "…" : "Refetch"}
              </button>
            )}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} className="bg-slate-50">
            <MetricDetail t={t} />
          </td>
        </tr>
      )}
    </>
  );
}

function MetricDetail({ t }: { t: Test }) {
  const core = coreMetrics(t);
  const seg = segmentalMetrics(t);
  return (
    <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-6">
      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
          Body composition
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {core.map((m) => (
            <div key={m.label} className="flex justify-between border-b border-slate-100 py-1">
              <dt className="text-slate-500">{m.label}</dt>
              <dd className="font-medium text-slate-900">{m.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div>
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
          Segmental Lean Analysis
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-slate-400 text-xs">
              <th className="text-left font-normal">Segment</th>
              <th className="text-right font-normal">Lean mass</th>
              <th className="text-right font-normal">%</th>
            </tr>
          </thead>
          <tbody>
            {seg.map((s) => (
              <tr key={s.segment} className="border-b border-slate-100">
                <td className="py-1 text-slate-500">{s.segment}</td>
                <td className="py-1 text-right font-medium text-slate-900">{s.mass}</td>
                <td className="py-1 text-right text-slate-600">{s.pct}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {t.fetchError && (
          <p className="text-xs text-amber-600 mt-3">{t.fetchError}</p>
        )}
      </div>
    </div>
  );
}

function ResultBadge({ status }: { status: string }) {
  const cls =
    status === "fetched"
      ? "badge-green"
      : status === "error"
        ? "badge-red"
        : status === "matched_no_data"
          ? "badge-yellow"
          : "badge-slate";
  return <span className={cls}>{status}</span>;
}

function MapModal({
  test,
  onClose,
  onMapped,
}: {
  test: Test;
  onClose: () => void;
  onMapped: () => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    debounce.current = setTimeout(async () => {
      setLoading(true);
      const res = await fetch(`/api/admin/customers/search?q=${encodeURIComponent(q)}`);
      const d = (await res.json().catch(() => ({ results: [] }))) as { results: SearchResult[] };
      setResults(d.results || []);
      setLoading(false);
    }, 250);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [q]);

  // Prefill with the test's phone to make matching easy.
  useEffect(() => {
    if (test.phone) setQ(test.phone);
  }, [test.phone]);

  async function map(customerId: string) {
    setSaving(true);
    await fetch(`/api/admin/inbody/tests/${test.id}/map`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerId }),
    });
    setSaving(false);
    onMapped();
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-lg p-5 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Map InBody test to a customer</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Test phone: {formatPhone(test.phone)} · {test.testedAt ? formatDate(test.testedAt) : "—"}
          </p>
        </div>
        <input
          autoFocus
          className="input"
          placeholder="Search by name, email, or phone"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="max-h-72 overflow-auto border border-slate-100 rounded-md divide-y">
          {loading && <div className="p-3 text-xs text-slate-400">Searching…</div>}
          {!loading && results.length === 0 && q.trim().length >= 2 && (
            <div className="p-3 text-xs text-slate-400">No customers found.</div>
          )}
          {results.map((r) => (
            <button
              key={r.id}
              disabled={saving}
              onClick={() => map(r.id)}
              className="w-full text-left px-3 py-2 hover:bg-slate-50 disabled:opacity-50"
            >
              <div className="text-sm font-medium text-slate-900">{r.label}</div>
              <div className="text-xs text-slate-500">
                {[r.email, r.phone && formatPhone(r.phone), r.clinic].filter(Boolean).join(" · ")}
              </div>
            </button>
          ))}
        </div>
        <div className="flex justify-end">
          <button className="btn-ghost text-sm" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
