/** Past imports for a clinic: counts only. Works as a server component. */
import type { ImportHistoryItem } from "@/lib/call-center/import-server";
import { formatDate } from "@/lib/format";

const SOURCE_LABEL: Record<string, string> = {
  csv: "CSV",
  xlsx: "Excel",
  zenoti: "Zenoti",
  mindbody: "Mindbody",
  aesthetic_record: "Aesthetic Record",
};

const n = (v: number) => v.toLocaleString("en-US");

/** Running for this long means the browser went away mid-import. */
const STALE_MS = 30 * 60 * 1000;

function statusBadge(i: ImportHistoryItem, now: number) {
  if (i.status === "done") return <span className="badge-green">Done</span>;
  if (i.status === "failed") return <span className="badge-red" title={i.error ?? undefined}>Stopped</span>;
  if (now - new Date(i.createdAt).getTime() > STALE_MS) {
    return <span className="badge-slate" title="The page was closed before it finished.">Didn&apos;t finish</span>;
  }
  return <span className="badge-yellow">Running</span>;
}

export function ImportHistory({ items, now = Date.now() }: { items: ImportHistoryItem[]; now?: number }) {
  if (!items.length) {
    return <div className="card-pad text-sm text-ink-muted">No imports yet.</div>;
  }
  return (
    <div className="card overflow-x-auto">
      <table className="table">
        <thead>
          <tr>
            <th>When</th>
            <th>From</th>
            <th>By</th>
            <th>Status</th>
            <th className="text-right">Rows</th>
            <th className="text-right">Added</th>
            <th className="text-right">Updated</th>
            <th className="text-right">Unchanged</th>
            <th className="text-right">No phone</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id}>
              <td className="whitespace-nowrap text-ink-muted text-xs">{formatDate(i.createdAt)}</td>
              <td className="max-w-[16rem]">
                <span className="font-medium">{SOURCE_LABEL[i.source] ?? i.source}</span>
                {i.fileName && <span className="block text-xs text-ink-subtle truncate">{i.fileName}</span>}
              </td>
              <td className="text-xs text-ink-muted whitespace-nowrap">{i.via === "clinic_link" ? "Clinic link" : "RevOS"}</td>
              <td>{statusBadge(i, now)}</td>
              <td className="text-right tabular-nums">{n(i.rowsTotal)}</td>
              <td className="text-right tabular-nums">{n(i.created)}</td>
              <td className="text-right tabular-nums">{n(i.updated)}</td>
              <td className="text-right tabular-nums">{n(i.skipped)}</td>
              <td className="text-right tabular-nums">{n(i.invalid)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
