import { formatDate } from "@/lib/format";
import { coreMetrics, segmentalMetrics, type InBodyTestRow } from "@/lib/inbody-display";
import { InBodyChart } from "./inbody-chart";

export type InBodyTabTest = InBodyTestRow & {
  id: string;
  testedAt: string | null;
  equip: string | null;
  equipSerial: string | null;
  deviceType: string | null;
  account: string | null;
  resultStatus: string;
  matchStatus: string;
  fetchError: string | null;
};

export function InBodyTab({ tests }: { tests: InBodyTabTest[] }) {
  if (tests.length === 0) {
    return (
      <div className="card-pad text-center text-slate-500 py-12">
        <p className="text-sm">No InBody tests for this customer yet.</p>
        <p className="text-xs text-slate-400 mt-1">
          Tests auto-pair by phone number when they arrive from LookinBody Web,
          or a super admin can map them from the InBody admin page.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <InBodyChart tests={tests} />

      {tests.map((t, idx) => (
        <TestDetail key={t.id} test={t} defaultOpen={idx === 0} />
      ))}
    </div>
  );
}

function TestDetail({ test, defaultOpen }: { test: InBodyTabTest; defaultOpen: boolean }) {
  const core = coreMetrics(test);
  const seg = segmentalMetrics(test);

  return (
    <details className="card-pad" open={defaultOpen}>
      <summary className="cursor-pointer flex items-center justify-between gap-4 list-none">
        <div>
          <span className="text-sm font-semibold text-slate-900">
            {test.testedAt ? formatDate(test.testedAt) : "Unknown date"}
          </span>
          <span className="text-xs text-slate-400 ml-2">
            {[test.equip, test.equipSerial].filter(Boolean).join(" · ") || "—"}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-slate-600">
            {core[0].value} · {core[5].value} BMI · {core[6].value}
          </span>
          <span
            className={
              test.resultStatus === "fetched"
                ? "badge-green"
                : test.resultStatus === "error"
                  ? "badge-red"
                  : "badge-slate"
            }
          >
            {test.resultStatus}
          </span>
        </div>
      </summary>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2">
            Body composition
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {core.map((m) => (
              <div
                key={m.label}
                className="flex justify-between border-b border-slate-100 py-1"
              >
                <dt className="text-slate-500">{m.label}</dt>
                <dd className="font-medium text-slate-900">{m.value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-2">
            Segmental Lean Analysis
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-slate-400 text-xs">
                <th className="text-left font-normal">Segment</th>
                <th className="text-right font-normal">Lean mass</th>
                <th className="text-right font-normal pr-1">%</th>
              </tr>
            </thead>
            <tbody>
              {seg.map((s) => (
                <tr key={s.segment} className="border-b border-slate-100 last:border-0">
                  <td className="py-1 text-slate-500">{s.segment}</td>
                  <td className="py-1 text-right font-medium text-slate-900">{s.mass}</td>
                  <td className="py-1 text-right text-slate-600 pr-1">{s.pct}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="mt-4 pt-3 border-t border-slate-100 flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-slate-400">
        <span>Device: {test.deviceType || "—"}</span>
        <span>Serial: {test.equipSerial || "—"}</span>
        <span>Account: {test.account || "—"}</span>
        <span>Match: {test.matchStatus}</span>
        {test.fetchError && <span className="text-amber-600">{test.fetchError}</span>}
      </div>
    </details>
  );
}
