"use client";

/**
 * The lead file import, start to finish: pick a file → sheet and header row →
 * columns (with a live preview) → statuses → options → import with progress →
 * counts.
 *
 * Everything up to "Import" happens in the browser. The server gets only the
 * normalized rows, 500 at a time (src/lib/call-center/import.ts).
 *
 * mode "staff": the call center's Import page (full mapping and status table).
 * mode "link":  the clinic's connect page. Columns are matched automatically
 *               with an option to fix them, statuses are guessed, and the
 *               result shows only what was sent, never what RevOS already had.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  cellText,
  chunk,
  CHUNK_SIZE,
  dataRows,
  FIELD_INFO,
  guessColumns,
  guessHeaderRow,
  headersFor,
  IMPORT_FIELDS,
  ImportFileError,
  mappingSummary,
  MAX_IMPORT_ROWS,
  normalizeRows,
  previewRows,
  statusCounts,
  type ColumnMap,
  type FileKind,
  type Grid,
  type ImportField,
  type ImportRow,
  type PriorityRule,
  type Sheet,
} from "@/lib/call-center/import";
import { STAGE_BADGE, STAGE_LABEL, STAGES, type Stage } from "@/lib/call-center/stages";
import { formatDay } from "@/lib/call-center/time";
import { formatPhone } from "@/lib/phone";
import { readSpreadsheetFile } from "./read-spreadsheet";

type Mode = "staff" | "link";

type LoadedFile = { name: string; kind: FileKind; sheets: Sheet[] };

type Result = {
  received: number;
  invalid: number;
  created?: number;
  updated?: number;
  skipped?: number;
  patients?: number;
};

type Phase =
  | { kind: "pick" }
  | { kind: "map" }
  | { kind: "importing"; sent: number; total: number }
  | { kind: "done"; result: Result }
  | { kind: "error"; message: string; resumeAt: number };

const n = (v: number) => v.toLocaleString("en-US");
const plural = (v: number, one: string, many: string) => `${n(v)} ${v === 1 ? one : many}`;

function apptLabel(v: string): string {
  const [day, time] = v.split("T");
  const [h, m] = time.split(":").map(Number);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${formatDay(day)} ${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function rowCount(s: Sheet) {
  return s.rows.filter((r) => r.some((c) => cellText(c) !== "")).length;
}

export function ImportFlow({ mode, endpoint }: { mode: Mode; endpoint: string }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [headerRow, setHeaderRow] = useState(0);
  const [columns, setColumns] = useState<ColumnMap>({});
  const [priority, setPriority] = useState<PriorityRule>({ mode: "yes" });
  const [statusMap, setStatusMap] = useState<Record<string, Stage>>({});
  const [consentAll, setConsentAll] = useState(false);
  const [updateStatuses, setUpdateStatuses] = useState(false);
  const [showColumns, setShowColumns] = useState(mode === "staff");
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const run = useRef<{ importId?: string; result: Result }>({ result: { received: 0, invalid: 0 } });

  const sheet = file?.sheets[sheetIndex] ?? null;
  const headers = useMemo(() => (sheet ? headersFor(sheet.rows, headerRow) : []), [sheet, headerRow]);
  const data = useMemo(() => (sheet ? dataRows(sheet.rows, headerRow) : []), [sheet, headerRow]);
  const opts = useMemo(() => ({ columns, priority, statusMap }), [columns, priority, statusMap]);
  const normalized = useMemo(() => normalizeRows(data, opts, headerRow), [data, opts, headerRow]);
  const preview = useMemo(() => previewRows(data, opts, headerRow, mode === "staff" ? 10 : 5), [data, opts, headerRow, mode]);
  const statuses = useMemo(() => statusCounts(data, columns.status), [data, columns.status]);
  const priorityValues = useMemo(
    () => (columns.priority === undefined ? [] : statusCounts(data, columns.priority).filter((s) => s.key).slice(0, 8)),
    [data, columns.priority],
  );

  // Don't let a closed tab cut an import short without a warning.
  useEffect(() => {
    if (phase.kind !== "importing") return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [phase.kind]);

  function guessFor(s: Sheet, hr: number) {
    const g = guessColumns(headersFor(s.rows, hr));
    setColumns(g.columns);
    setPriority(g.priority);
    setStatusMap({});
  }

  async function openFile(f: File) {
    setFileError(null);
    setReading(true);
    try {
      const loaded = await readSpreadsheetFile(f);
      // Start on the sheet with the most rows (a workbook's first sheet is
      // sometimes instructions).
      let best = 0;
      loaded.sheets.forEach((s, i) => {
        if (rowCount(s) > rowCount(loaded.sheets[best])) best = i;
      });
      const hr = guessHeaderRow(loaded.sheets[best].rows);
      setFile({ name: f.name, ...loaded });
      setSheetIndex(best);
      setHeaderRow(hr);
      guessFor(loaded.sheets[best], hr);
      setConsentAll(false);
      setUpdateStatuses(false);
      setPhase({ kind: "map" });
    } catch (e) {
      setFileError(e instanceof ImportFileError ? e.message : "This file couldn't be read. Try saving it as .xlsx or CSV.");
    } finally {
      setReading(false);
    }
  }

  function reset() {
    setFile(null);
    setFileError(null);
    setPhase({ kind: "pick" });
    run.current = { result: { received: 0, invalid: 0 } };
    if (inputRef.current) inputRef.current.value = "";
  }

  function setColumn(field: ImportField, value: string) {
    setColumns((c) => {
      const next = { ...c };
      if (value === "") delete next[field];
      else next[field] = Number(value);
      return next;
    });
    // Category columns ("Segment", "Tags") need the text that marks priority.
    if (field === "priority") {
      setPriority(/segment|^tag/i.test(headers[Number(value)] ?? "") ? { mode: "contains", text: "" } : { mode: "yes" });
    }
  }

  /** Start an import, or (resume) carry on the one that stopped at chunk `startAt`. */
  async function runImport(startAt: number, resume = false) {
    if (!file || !sheet) return;
    const rows = normalized.rows;
    const parts = chunk<ImportRow>(rows, CHUNK_SIZE);
    if (!parts.length) return;
    if (!resume) run.current = { result: { received: 0, invalid: 0 } };
    const summary = mappingSummary({
      sheet: file.kind === "xlsx" ? sheet.name : null,
      headerRow,
      headers,
      columns,
      statuses: mode === "staff" ? statuses : [],
      statusMap,
      priority,
    });
    setPhase({ kind: "importing", sent: startAt * CHUNK_SIZE, total: rows.length });
    for (let i = startAt; i < parts.length; i++) {
      const last = i === parts.length - 1;
      const body = {
        importId: run.current.importId,
        source: file.kind,
        fileName: file.name.slice(0, 200),
        mapping: run.current.importId ? undefined : summary,
        options: {
          consentAll,
          updateStatuses: mode === "staff" && updateStatuses,
          priorityMapped: columns.priority !== undefined,
        },
        rows: parts[i],
        done: last,
        fileStats: last ? { invalid: normalized.stats.invalid, duplicates: normalized.stats.duplicates } : undefined,
      };
      let res: Response;
      let json: {
        importId?: string;
        error?: string;
        counts?: Partial<Result> & { received?: number };
        totals?: { rowsTotal: number; created: number; updated: number; skipped: number; invalid: number };
      };
      try {
        res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        json = await res.json().catch(() => ({}));
      } catch {
        setPhase({ kind: "error", message: "Lost the connection. Check your internet, then try again.", resumeAt: i });
        return;
      }
      if (json.importId) run.current.importId = json.importId;
      if (!res.ok) {
        setPhase({ kind: "error", message: json.error || "Something went wrong. Try again.", resumeAt: i });
        return;
      }
      run.current.result.patients = (run.current.result.patients ?? 0) + (json.counts?.patients ?? 0);
      setPhase({ kind: "importing", sent: Math.min((i + 1) * CHUNK_SIZE, rows.length), total: rows.length });
      if (last) {
        const t = json.totals;
        const result: Result =
          mode === "staff" && t
            ? {
                received: t.rowsTotal,
                invalid: t.invalid,
                created: t.created,
                updated: t.updated,
                skipped: t.skipped,
                patients: run.current.result.patients,
              }
            : { received: normalized.stats.leads, invalid: normalized.stats.invalid };
        setPhase({ kind: "done", result });
        router.refresh();
      }
    }
  }

  // ── Pick a file ──
  if (phase.kind === "pick") {
    return (
      <div className="card-pad">
        <div
          className={`rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
            dragging ? "border-brand-900 bg-surface-alt" : "border-line"
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            const f = e.dataTransfer.files?.[0];
            if (f) void openFile(f);
          }}
        >
          <p className="text-sm font-medium text-ink">
            {mode === "staff" ? "Drop a lead file here" : "Drop your spreadsheet here"}
          </p>
          <p className="text-xs text-ink-subtle mt-1">Excel (.xlsx) or CSV. It stays on this computer until you press Import.</p>
          <button
            type="button"
            className="btn-primary mt-4"
            disabled={reading}
            onClick={() => inputRef.current?.click()}
          >
            {reading ? "Reading…" : "Choose file"}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx,.xlsm,.csv,.txt,.tsv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void openFile(f);
            }}
          />
        </div>
        {fileError && <p className="mt-3 text-sm text-red-600">{fileError}</p>}
      </div>
    );
  }

  if (!file || !sheet) return null;

  // ── Importing / done / error ──
  if (phase.kind === "importing") {
    const pct = phase.total ? Math.round((phase.sent / phase.total) * 100) : 0;
    return (
      <div className="card-pad">
        <p className="text-sm font-medium text-ink">
          {mode === "staff" ? "Importing" : "Sending"} {plural(phase.total, "lead", "leads")}…
        </p>
        <div className="mt-3 h-2 w-full rounded-full bg-surface-alt overflow-hidden">
          <div className="h-full bg-brand-900 transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-xs text-ink-subtle mt-2">
          {n(phase.sent)} of {n(phase.total)}. Keep this page open.
        </p>
      </div>
    );
  }

  if (phase.kind === "done") {
    const r = phase.result;
    return (
      <div className="card-pad space-y-4">
        <div>
          <p className="text-sm font-semibold text-ink">
            {mode === "staff" ? "Import finished" : "Thanks! Your leads are with RevOS."}
          </p>
          <p className="text-xs text-ink-subtle mt-0.5">{file.name}</p>
        </div>
        {mode === "staff" ? (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
            <Stat label="Added" value={r.created ?? 0} />
            <Stat label="Updated" value={r.updated ?? 0} />
            <Stat label="Unchanged" value={r.skipped ?? 0} hint="Nothing new, or a repeat in the file" />
            <Stat label="No usable phone" value={r.invalid} />
            <Stat label="Already patients" value={r.patients ?? 0} hint="Marked Showed so nobody cold-calls them" />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 max-w-md">
            <Stat label="Leads sent" value={r.received} />
            <Stat label="No usable phone" value={r.invalid} />
          </div>
        )}
        <button type="button" className="btn-secondary" onClick={reset}>
          {mode === "staff" ? "Import another file" : "Upload another file"}
        </button>
      </div>
    );
  }

  // ── Map ──
  const stats = normalized.stats;
  const tooMany = stats.leads > MAX_IMPORT_ROWS;
  const noPhone = columns.phone === undefined;
  const needsPriorityText = priority.mode === "contains" && !priority.text.trim();
  const canImport = !noPhone && stats.leads > 0 && !tooMany;
  const shown = (f: ImportField) => columns[f] !== undefined;

  return (
    <div className="space-y-4">
      {phase.kind === "error" && (
        <div className="card-pad border-red-200 bg-red-50/40">
          <p className="text-sm font-medium text-red-700">{phase.message}</p>
          <p className="text-xs text-ink-subtle mt-1">
            {phase.resumeAt > 0
              ? `${n(Math.min(phase.resumeAt * CHUNK_SIZE, stats.leads))} of ${n(stats.leads)} leads were saved. Trying again picks up from there.`
              : "Nothing was saved yet."}
          </p>
          <div className="flex gap-2 mt-3">
            <button type="button" className="btn-primary" onClick={() => void runImport(phase.resumeAt, true)}>
              Try again
            </button>
            <button type="button" className="btn-secondary" onClick={reset}>
              Start over
            </button>
          </div>
        </div>
      )}

      <div className="card-pad">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink truncate">{file.name}</p>
            <p className="text-xs text-ink-subtle mt-0.5">
              {plural(stats.rows, "row", "rows")}
              {file.sheets.length > 1 ? ` on this sheet · ${file.sheets.length} sheets` : ""}
            </p>
          </div>
          <button type="button" className="btn-ghost text-xs" onClick={reset}>
            Choose another file
          </button>
        </div>
        {(file.sheets.length > 1 || showColumns) && (
          <div className="grid sm:grid-cols-2 gap-4 mt-4">
            {file.sheets.length > 1 && (
              <div>
                <label className="label" htmlFor="import-sheet">Sheet</label>
                <select
                  id="import-sheet"
                  className="input"
                  value={sheetIndex}
                  onChange={(e) => {
                    const i = Number(e.target.value);
                    const hr = guessHeaderRow(file.sheets[i].rows);
                    setSheetIndex(i);
                    setHeaderRow(hr);
                    guessFor(file.sheets[i], hr);
                  }}
                >
                  {file.sheets.map((s, i) => (
                    <option key={`${s.name}-${i}`} value={i}>
                      {s.name} ({plural(rowCount(s), "row", "rows")})
                    </option>
                  ))}
                </select>
              </div>
            )}
            {showColumns && (
              <div>
                <label className="label" htmlFor="import-header">Header row</label>
                <select
                  id="import-header"
                  className="input"
                  value={headerRow}
                  onChange={(e) => {
                    const hr = Number(e.target.value);
                    setHeaderRow(hr);
                    guessFor(sheet, hr);
                  }}
                >
                  {sheet.rows.slice(0, 25).map((r, i) => (
                    <option key={i} value={i}>
                      Row {i + 1}: {r.map(cellText).filter(Boolean).slice(0, 4).join(", ").slice(0, 60) || "(empty)"}
                    </option>
                  ))}
                </select>
                <p className="help-text">The row with the column titles.</p>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="card-pad">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="section-title">Columns</h3>
            <p className="section-subtitle">
              {mode === "staff" ? "Check which column holds what." : "We matched your columns. Fix any that look wrong."}
            </p>
          </div>
          {mode === "link" && (
            <button type="button" className="btn-ghost text-xs" onClick={() => setShowColumns((v) => !v)}>
              {showColumns ? "Hide" : "Fix columns"}
            </button>
          )}
        </div>

        {!showColumns ? (
          <div className="flex flex-wrap gap-2 mt-4">
            {IMPORT_FIELDS.filter(shown).map((f) => (
              <span key={f} className="badge-slate">
                {FIELD_INFO[f].label}: {headers[columns[f]!]}
              </span>
            ))}
          </div>
        ) : (
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-4 mt-4">
            {IMPORT_FIELDS.map((f) => {
              const sample = columns[f] === undefined ? "" : firstValue(data, columns[f]!);
              return (
                <div key={f}>
                  <label className="label" htmlFor={`col-${f}`}>
                    {FIELD_INFO[f].label}
                  </label>
                  <select
                    id={`col-${f}`}
                    className="input"
                    value={columns[f] ?? ""}
                    onChange={(e) => setColumn(f, e.target.value)}
                  >
                    <option value="">Not in this file</option>
                    {headers.map((h, i) => (
                      <option key={i} value={i}>
                        {h}
                      </option>
                    ))}
                  </select>
                  <p className="help-text truncate">{sample ? `e.g. ${sample}` : FIELD_INFO[f].help || " "}</p>
                </div>
              );
            })}
          </div>
        )}

        {noPhone && <p className="mt-4 text-sm text-red-600">Pick the column with phone numbers. Every lead needs one.</p>}

        {columns.priority !== undefined && showColumns && (
          <div className="mt-5 rounded-xl border border-line p-4">
            <p className="text-sm font-medium text-ink">Who is a priority lead?</p>
            <div className="flex flex-col gap-2 mt-2 text-sm text-ink">
              <label className="inline-flex items-center gap-2">
                <input
                  type="radio"
                  checked={priority.mode === "yes"}
                  onChange={() => setPriority({ mode: "yes" })}
                />
                Anyone with Yes, X or any other value in &ldquo;{headers[columns.priority]}&rdquo;
              </label>
              <label className="inline-flex items-center gap-2 flex-wrap">
                <input
                  type="radio"
                  checked={priority.mode === "contains"}
                  onChange={() => setPriority({ mode: "contains", text: priority.mode === "contains" ? priority.text : "" })}
                />
                Anyone whose value contains
                <input
                  className="input w-40 py-1.5"
                  placeholder="e.g. GLP-1"
                  value={priority.mode === "contains" ? priority.text : ""}
                  onFocus={() => priority.mode !== "contains" && setPriority({ mode: "contains", text: "" })}
                  onChange={(e) => setPriority({ mode: "contains", text: e.target.value })}
                />
              </label>
            </div>
            {priorityValues.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-3">
                {priorityValues.map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    className="badge-slate hover:border-neutral-300"
                    onClick={() => setPriority({ mode: "contains", text: v.label })}
                  >
                    {v.label} ({n(v.count)})
                  </button>
                ))}
              </div>
            )}
            {needsPriorityText && (
              <p className="help-text">Type or pick the value that marks a priority lead. Until then nobody is marked.</p>
            )}
          </div>
        )}
      </div>

      {!noPhone && (
        <div className="card overflow-hidden">
          <div className="px-6 pt-5 pb-3">
            <h3 className="section-title">Preview</h3>
            <p className="section-subtitle">
              The first {preview.length} rows as they will be {mode === "staff" ? "imported" : "sent"}.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Name</th>
                  <th>Phone</th>
                  {shown("email") && <th>Email</th>}
                  {shown("status") && <th>Status</th>}
                  {shown("lastCalled") && <th>Last called</th>}
                  {shown("appointment") && <th>Appointment</th>}
                  {shown("priority") && <th>Priority</th>}
                  {shown("consent") && <th>Agreed</th>}
                  {(shown("note") || shown("source")) && <th>Notes</th>}
                </tr>
              </thead>
              <tbody>
                {preview.map(({ sheetRow, row }) => (
                  <tr key={sheetRow}>
                    <td className="text-ink-subtle tabular-nums">{sheetRow}</td>
                    {row ? (
                      <>
                        <td>{[row.firstName, row.lastName].filter(Boolean).join(" ") || "(no name)"}</td>
                        <td className="tabular-nums whitespace-nowrap">{formatPhone(row.phone)}</td>
                        {shown("email") && <td className="text-ink-muted">{row.email || "—"}</td>}
                        {shown("status") && (
                          <td className="whitespace-nowrap">
                            <span className="text-ink-muted">{row.status || "—"}</span>
                            {mode === "staff" && (
                              <span className={`ml-2 ${STAGE_BADGE[row.stage ?? "new"]}`}>{STAGE_LABEL[row.stage ?? "new"]}</span>
                            )}
                          </td>
                        )}
                        {shown("lastCalled") && (
                          <td className="whitespace-nowrap">{row.lastCalledDay ? formatDay(row.lastCalledDay) : "—"}</td>
                        )}
                        {shown("appointment") && (
                          <td className="whitespace-nowrap">{row.appointment ? apptLabel(row.appointment) : "—"}</td>
                        )}
                        {shown("priority") && <td>{row.priority ? <span className="badge-yellow">Priority</span> : "—"}</td>}
                        {shown("consent") && <td>{row.consent ? "Yes" : "—"}</td>}
                        {(shown("note") || shown("source")) && (
                          <td className="max-w-xs truncate text-ink-muted">
                            {[row.source ? `Source: ${row.source}` : "", row.note ?? ""].filter(Boolean).join(" · ") || "—"}
                          </td>
                        )}
                      </>
                    ) : (
                      <td colSpan={9} className="text-red-600">
                        No usable phone. This row will be skipped.
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {mode === "staff" && statuses.length > 0 && (
        <div className="card overflow-hidden">
          <div className="px-6 pt-5 pb-3">
            <h3 className="section-title">Statuses</h3>
            <p className="section-subtitle">Where each status in the file lands on the desk. Change any that are wrong.</p>
          </div>
          <table className="table">
            <thead>
              <tr>
                <th>In the file</th>
                <th className="text-right">Rows</th>
                <th>On the desk</th>
              </tr>
            </thead>
            <tbody>
              {statuses.slice(0, 60).map((s) => (
                <tr key={s.key}>
                  <td className={s.key ? "text-ink" : "text-ink-subtle"}>{s.label}</td>
                  <td className="text-right tabular-nums">{n(s.count)}</td>
                  <td>
                    <select
                      className="input py-1.5 max-w-[14rem]"
                      value={statusMap[s.key] ?? s.guess}
                      onChange={(e) => setStatusMap((m) => ({ ...m, [s.key]: e.target.value as Stage }))}
                    >
                      {STAGES.map((st) => (
                        <option key={st} value={st}>
                          {STAGE_LABEL[st]}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {statuses.length > 60 && (
            <p className="px-6 py-3 text-xs text-ink-subtle">
              {n(statuses.length - 60)} more statuses are guessed automatically.
            </p>
          )}
        </div>
      )}

      <div className="card-pad space-y-4">
        <label className="flex items-start gap-3 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={consentAll}
            onChange={(e) => setConsentAll(e.target.checked)}
          />
          <span>
            These people agreed in writing to be called
            <span className="block text-xs text-ink-subtle">
              For example, the form they filled in had consent text. Only tick this if it&apos;s true for everyone in the file.
            </span>
          </span>
        </label>
        {mode === "staff" && (
          <label className="flex items-start gap-3 text-sm text-ink">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={updateStatuses}
              onChange={(e) => setUpdateStatuses(e.target.checked)}
            />
            <span>
              Update statuses from this file
              <span className="block text-xs text-ink-subtle">
                Only for leads nobody has worked on the desk yet. &ldquo;Do not call&rdquo; always applies.
              </span>
            </span>
          </label>
        )}

        <p className="text-sm text-ink-muted">
          {plural(stats.leads, "lead", "leads")} to {mode === "staff" ? "import" : "send"}
          {stats.invalid > 0 && (
            <>
              {" · "}
              <span className="text-red-600">
                {plural(stats.invalid, "row", "rows")} with no usable phone
                {normalized.invalidRows.length > 0 &&
                  ` (row${normalized.invalidRows.length > 1 ? "s" : ""} ${normalized.invalidRows.join(", ")}${stats.invalid > normalized.invalidRows.length ? "…" : ""})`}
              </span>
            </>
          )}
          {stats.duplicates > 0 && ` · ${plural(stats.duplicates, "repeated phone", "repeated phones")} merged`}
        </p>
        {tooMany && (
          <p className="text-sm text-red-600">
            One import can hold {n(MAX_IMPORT_ROWS)} leads. Split the file and import it in parts.
          </p>
        )}

        <button
          type="button"
          className="btn-primary"
          disabled={!canImport || phase.kind === "error"}
          onClick={() => void runImport(0)}
        >
          {mode === "staff" ? "Import" : "Send"} {plural(stats.leads, "lead", "leads")}
        </button>
      </div>
    </div>
  );
}

function firstValue(rows: Grid, col: number): string {
  for (const r of rows.slice(0, 50)) {
    const t = cellText(r[col]);
    if (t) return t.slice(0, 40);
  }
  return "";
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-xl border border-line px-4 py-3" title={hint}>
      <div className="text-xl font-semibold text-ink tabular-nums">{n(value)}</div>
      <div className="text-xs text-ink-subtle mt-0.5">{label}</div>
    </div>
  );
}
