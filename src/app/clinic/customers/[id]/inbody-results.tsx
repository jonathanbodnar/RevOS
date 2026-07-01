import { formatDate } from "@/lib/format";
import { coreMetrics, segmentalMetrics, type InBodyTestRow } from "@/lib/inbody-display";
import { InBodyChart } from "./inbody-chart";

type Test = InBodyTestRow & {
  id: string;
  testedAt: string | null;
  equip: string | null;
  resultStatus: string;
};

export function InBodyResults({ tests }: { tests: Test[] }) {
  if (tests.length === 0) return null;

  const latest = tests[0];
  const core = coreMetrics(latest);
  const seg = segmentalMetrics(latest);

  return (
    <>
      <InBodyChart tests={tests} />
      <div className="card-pad">
      <div className="flex items-baseline justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-900">InBody results</h3>
        <span className="text-xs text-slate-400">
          {latest.testedAt ? formatDate(latest.testedAt) : "—"}
          {latest.equip ? ` · ${latest.equip}` : ""}
        </span>
      </div>

      {latest.resultStatus !== "fetched" && (
        <p className="text-xs text-amber-600 mb-3">
          Test received — full metrics pending sync from InBody.
        </p>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-2 mb-4">
        {core.map((m) => (
          <div key={m.label} className="rounded-md bg-slate-50 px-3 py-2">
            <div className="text-[11px] leading-tight text-slate-500">{m.label}</div>
            <div className="text-sm font-semibold text-slate-900">{m.value}</div>
          </div>
        ))}
      </div>

      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
        Segmental Lean Analysis
      </div>
      <table className="w-full text-sm mb-2">
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

      {tests.length > 1 && (
        <details className="mt-2">
          <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-700">
            History ({tests.length} tests)
          </summary>
          <table className="w-full text-xs mt-2">
            <thead>
              <tr className="text-slate-400">
                <th className="text-left font-normal">Date</th>
                <th className="text-right font-normal">Weight</th>
                <th className="text-right font-normal">SMM</th>
                <th className="text-right font-normal">PBF</th>
                <th className="text-right font-normal pr-1">BMI</th>
              </tr>
            </thead>
            <tbody>
              {tests.map((t) => {
                const c = coreMetrics(t);
                return (
                  <tr key={t.id} className="border-b border-slate-100 last:border-0">
                    <td className="py-1 text-slate-500">
                      {t.testedAt ? formatDate(t.testedAt) : "—"}
                    </td>
                    <td className="py-1 text-right">{c[0].value}</td>
                    <td className="py-1 text-right">{c[3].value}</td>
                    <td className="py-1 text-right">{c[6].value}</td>
                    <td className="py-1 text-right pr-1">{c[5].value}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </details>
      )}
      </div>
    </>
  );
}
