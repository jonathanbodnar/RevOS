/**
 * Lead import: reading spreadsheets, guessing columns and statuses, and turning
 * sheet rows into the rows the server imports.
 *
 * Isomorphic (no server imports). The browser runs all of this, so a clinic's
 * file never reaches RevOS: only normalized rows do, in chunks of CHUNK_SIZE.
 * The server checks every row again with ImportRowSchema before writing
 * (import-server.ts), and CRM connectors (src/lib/crm/) reuse normalizeRecord.
 *
 * The column and status guesses are ported from the Dial Desk prototype the
 * call center used with its Google Sheet exports.
 */
import { z } from "zod";
import { normalizePhone } from "../phone";
import { STAGES, type Stage } from "./stages";

// ── Limits ──────────────────────────────────────────────────────────────────

/** Rows per request to the import API. */
export const CHUNK_SIZE = 500;
/** Rows one import may hold (after blank rows are dropped). */
export const MAX_IMPORT_ROWS = 50_000;
/** Largest file the browser will open. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_NOTE_LENGTH = 2000;
/** Rows scanned when guessing the header row. */
const HEADER_SCAN_ROWS = 25;

// ── Cells and sheets ────────────────────────────────────────────────────────

/** One spreadsheet cell as read from CSV (always text) or Excel. */
export type Cell = string | number | boolean | Date | null | undefined;
export type Grid = Cell[][];
export type Sheet = { name: string; rows: Grid };

/** A message safe to show the person importing. */
export class ImportFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportFileError";
  }
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Excel stores a date as a wall-clock time with no zone; read-excel-file hands
 * it back as a Date whose UTC fields are that wall clock. We keep it that way.
 */
function utcWallClock(d: Date) {
  return {
    day: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  };
}

/** Single-line display text of a cell. */
export function cellText(v: Cell): string {
  if (v == null) return "";
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return "";
    const w = utcWallClock(v);
    return w.time === "00:00" ? w.day : `${w.day} ${w.time}`;
  }
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v).replace(/\s+/g, " ").trim();
}

/** Multi-line text (notes): keeps line breaks, trims each line. */
function multilineText(v: Cell): string {
  if (typeof v !== "string") return cellText(v);
  return v
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isBlankRow(row: Cell[] | undefined): boolean {
  return !row || row.every((c) => cellText(c) === "");
}

// ── Text files ──────────────────────────────────────────────────────────────

/**
 * Decode an uploaded text file. Excel's plain "CSV" export on Windows is
 * Windows-1252, its "Unicode text" is UTF-16; everything else is UTF-8.
 */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

export type FileKind = "csv" | "xlsx";

/** What kind of file this is, from its first bytes and name. Throws ImportFileError. */
export function detectFileKind(name: string, head: Uint8Array): FileKind {
  const lower = name.toLowerCase();
  const zip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  const oldExcel = head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0;
  if (oldExcel || lower.endsWith(".xls")) {
    throw new ImportFileError(
      "This is an old Excel file (.xls). Open it in Excel, choose Save As, pick Excel Workbook (.xlsx) or CSV, then upload that.",
    );
  }
  if (lower.endsWith(".numbers")) {
    throw new ImportFileError("Numbers files can't be read. In Numbers, choose File, Export To, CSV or Excel, then upload that.");
  }
  // An .xlsx file is a zip archive; anything else is read as text.
  if (zip) return "xlsx";
  if (/\.xls[xm]$/.test(lower)) {
    throw new ImportFileError("This file doesn't look like an Excel workbook. Save it again as .xlsx or CSV and try again.");
  }
  return "csv";
}

// ── CSV ─────────────────────────────────────────────────────────────────────

export type Delimiter = "," | ";" | "\t";
const DELIMITERS: Delimiter[] = [",", ";", "\t"];

/**
 * Parse CSV text into rows of strings. Handles quoted fields with embedded
 * delimiters, line breaks and doubled quotes, CRLF / LF / CR line endings and
 * a UTF-8 BOM. Lenient about stray quotes the way spreadsheet apps are.
 */
export function parseCsv(input: string, delimiter?: Delimiter): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const d = delimiter ?? detectDelimiter(text);
  const rows: string[][] = [];
  const n = text.length;
  let row: string[] = [];
  let i = 0;
  while (i < n) {
    // Spaces before an opening quote are dropped (`a, "b"`).
    let j = i;
    while (j < n && text[j] === " ") j++;
    if (j < n && text[j] === '"') {
      j++;
      let value = "";
      let start = j;
      for (;;) {
        const q = text.indexOf('"', j);
        if (q === -1) {
          // Unclosed quote: the rest of the file is this field.
          value += text.slice(start);
          j = n;
          break;
        }
        if (text[q + 1] === '"') {
          value += text.slice(start, q + 1);
          j = q + 2;
          start = j;
          continue;
        }
        value += text.slice(start, q);
        j = q + 1;
        break;
      }
      // Anything between the closing quote and the delimiter is kept.
      let k = j;
      while (k < n && text[k] !== d && text[k] !== "\n" && text[k] !== "\r") k++;
      row.push(k > j ? value + text.slice(j, k) : value);
      i = k;
    } else {
      let k = i;
      while (k < n && text[k] !== d && text[k] !== "\n" && text[k] !== "\r") k++;
      row.push(text.slice(i, k));
      i = k;
    }
    if (i >= n) {
      rows.push(row);
      row = [];
      break;
    }
    if (text[i] === d) {
      i++;
      if (i >= n) {
        row.push("");
        rows.push(row);
        row = [];
      }
      continue;
    }
    rows.push(row);
    row = [];
    i += text[i] === "\r" && text[i + 1] === "\n" ? 2 : 1;
  }
  return rows;
}

/** Comma, semicolon (European Excel) or tab, judged on the first rows. */
export function detectDelimiter(text: string): Delimiter {
  const cut = text.length > 32768;
  const sample = cut ? text.slice(0, 32768) : text;
  let best: Delimiter = ",";
  let bestScore = 0;
  for (const d of DELIMITERS) {
    let rows = parseCsv(sample, d);
    if (cut) rows = rows.slice(0, -1); // the last row may be cut short
    rows = rows.filter((r) => r.some((c) => c.trim() !== "")).slice(0, 10);
    if (!rows.length || rows[0].length < 2) continue;
    const width = rows[0].length;
    const same = rows.filter((r) => r.length === width).length / rows.length;
    const score = same * 100 + Math.min(width, 50);
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** One sheet from a text file. */
export function sheetsFromCsv(text: string): Sheet[] {
  return [{ name: "Sheet 1", rows: parseCsv(text) }];
}

// ── Header row and columns ──────────────────────────────────────────────────

const HEADER_HINT = /phone|mobile|cell|name|e-?mail|status|first|last|patient|client|guest/i;

/** Best guess at the header row (0-based): the first row that looks like one. */
export function guessHeaderRow(rows: Grid): number {
  const limit = Math.min(rows.length, HEADER_SCAN_ROWS);
  let firstFilled = -1;
  for (let r = 0; r < limit; r++) {
    const texts = (rows[r] || []).map(cellText).filter(Boolean);
    if (texts.length < 2) continue;
    if (firstFilled < 0) firstFilled = r;
    const wordy = texts.filter((t) => !/^[\d\s()+\-./:]+$/.test(t));
    if (wordy.length >= 2 && texts.some((t) => HEADER_HINT.test(t))) return r;
  }
  return Math.max(firstFilled, 0);
}

export function columnLetter(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Column titles for a header row, made unique; blank ones become "Column C". */
export function headersFor(rows: Grid, headerRow: number): string[] {
  let width = 0;
  for (let r = headerRow; r < Math.min(rows.length, headerRow + 200); r++) {
    width = Math.max(width, rows[r]?.length ?? 0);
  }
  const seen = new Map<string, number>();
  const out: string[] = [];
  for (let c = 0; c < width; c++) {
    let h = cellText(rows[headerRow]?.[c]) || `Column ${columnLetter(c)}`;
    const key = h.toLowerCase();
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > 1) h = `${h} (${n})`;
    out.push(h);
  }
  return out;
}

export function dataRows(rows: Grid, headerRow: number): Grid {
  return rows.slice(headerRow + 1);
}

// ── Fields and mapping ──────────────────────────────────────────────────────

export const IMPORT_FIELDS = [
  "phone",
  "fullName",
  "firstName",
  "lastName",
  "email",
  "status",
  "lastCalled",
  "appointment",
  "note",
  "priority",
  "consent",
  "externalId",
  "source",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

export const FIELD_INFO: Record<ImportField, { label: string; help: string }> = {
  phone: { label: "Phone", help: "Required. US numbers with 10 digits." },
  fullName: { label: "Full name", help: "Split into first and last name." },
  firstName: { label: "First name", help: "" },
  lastName: { label: "Last name", help: "" },
  email: { label: "Email", help: "" },
  status: { label: "Status", help: "Their status in your sheet or CRM." },
  lastCalled: { label: "Last called", help: "Date of the last call." },
  appointment: { label: "Appointment", help: "Date and time of a booked visit." },
  note: { label: "Notes", help: "" },
  priority: { label: "Priority", help: "Marks leads to call first." },
  consent: { label: "Agreed to calls", help: "Yes, X or a date means they agreed in writing." },
  externalId: { label: "CRM id", help: "Their id in your CRM." },
  source: { label: "Lead source", help: "Added to the notes, e.g. Facebook." },
};

/** Field → column index in the sheet. */
export type ColumnMap = Partial<Record<ImportField, number>>;

/**
 * How the priority column marks a lead: any yes-like value, or (the Dial
 * Desk's "priority text") a value containing some text, like "GLP-1".
 */
export type PriorityRule = { mode: "yes" } | { mode: "contains"; text: string };

type Guess = { patterns: RegExp[]; deny?: RegExp; prefer?: RegExp };

const NAME_DENY =
  /clinic|cent(er|re)|location|provider|staff|employee|campaign|business|company|practice|referr|form|ad ?set|user ?name|file|\b(id|code|number|no)\b|#|date|status|first|last|e-?mail|phone/i;

/**
 * Dial Desk GUESS patterns (name, phone, status, last, note, prio) plus the
 * fields the desk didn't have. Tried in this order; a column goes to the first
 * field that claims it, and within a field the first pattern that matches wins.
 */
const GUESS_ORDER: [ImportField, Guess][] = [
  [
    "phone",
    {
      patterns: [/phone/i, /mobile/i, /cell/i, /number/i],
      deny: /type|\bext\b|extension|country|opt.?(in|out)|consent|permission|verified|status|date|member|invoice|account|card|record|zip|postal|\bid\b|count/i,
      prefer: /mobile|cell/i,
    },
  ],
  ["email", { patterns: [/^e-?mail( address)?$/i, /e-?mail/i], deny: /opt|consent|status|verified|bounce|unsub/i }],
  ["firstName", { patterns: [/^first/i, /first ?name/i], deny: /visit|seen|date|appoint|call|contact|time/i }],
  ["lastName", { patterns: [/^last ?name$/i, /last ?name/i, /surname/i, /family ?name/i] }],
  [
    "fullName",
    {
      patterns: [/^name$/i, /full ?name/i, /name/i, /patient/i, /client/i, /^(guest|lead|contact|customer)$/i],
      deny: NAME_DENY,
    },
  ],
  [
    "status",
    {
      patterns: [/^status$/i, /status/i, /stage/i, /disposition/i],
      deny: /marital|e-?mail|sms|text|payment|invoice|membership|account/i,
    },
  ],
  [
    "lastCalled",
    { patterns: [/last.*call/i, /call.*date/i, /date.*call/i, /last contact/i, /last ?(attempt|dial)/i] },
  ],
  [
    "appointment",
    {
      patterns: [
        /^appointment$/i,
        /^appt$/i,
        /appointment.*(date|time)/i,
        /appt.*(date|time)/i,
        /(next|upcoming|booked) ?(appointment|appt|visit)/i,
        /appointment/i,
        /appt/i,
      ],
      deny: /status|type|count|notes?|reason|provider|location|service|\bid\b|cancel|no.?show|created/i,
    },
  ],
  // Only explicit consent columns. An SMS or email opt-in isn't permission to
  // be called with a dialer, so those are left for a person to map.
  ["consent", { patterns: [/consent/i, /tcpa/i], deny: /e-?mail|opt.?out|unsub|withdr/i }],
  ["note", { patterns: [/^notes?$/i, /^call notes?/i, /comment/i, /note/i] }],
  ["priority", { patterns: [/tirz/i, /segment/i, /priority/i, /^tag/i] }],
  [
    "externalId",
    {
      patterns: [
        /^id$/i,
        /^(guest|client|patient|lead|contact|customer|member) ?(id|code|#|number)$/i,
        /external ?id/i,
        /crm ?id/i,
        /record ?(id|#)/i,
        /^code$/i,
        /\bid$/i,
      ],
      deny: /phone|e-?mail|cent(er|re)|location|provider|staff|invoice|appointment|card/i,
    },
  ],
  [
    "source",
    {
      patterns: [/^source$/i, /lead ?source/i, /^utm.?source/i, /source/i, /referr/i, /campaign/i, /^how did/i],
      deny: /status/i,
    },
  ],
];

export type MappingGuess = { columns: ColumnMap; priority: PriorityRule };

/** Guess which column holds which field. */
export function guessColumns(headers: string[]): MappingGuess {
  const columns: ColumnMap = {};
  const taken = new Set<number>();
  for (const [field, g] of GUESS_ORDER) {
    // A first-name column means any generic "Name" column isn't the full name.
    if (field === "fullName" && columns.firstName !== undefined) continue;
    for (const p of g.patterns) {
      const hits: number[] = [];
      headers.forEach((h, i) => {
        if (!taken.has(i) && p.test(h) && !(g.deny && g.deny.test(h))) hits.push(i);
      });
      if (!hits.length) continue;
      const pick = (g.prefer && hits.find((i) => g.prefer!.test(headers[i]))) ?? hits[0];
      columns[field] = pick;
      taken.add(pick);
      break;
    }
  }
  // "Tirzepatide" / "Priority" columns hold yes/no marks. "Segment" / "Tags"
  // hold categories, so they need the text that marks priority (Dial Desk's
  // prioText) before anyone is flagged.
  const p = columns.priority;
  const priority: PriorityRule =
    p !== undefined && /segment|^tag/i.test(headers[p]) ? { mode: "contains", text: "" } : { mode: "yes" };
  return { columns, priority };
}

// ── Status → stage ──────────────────────────────────────────────────────────

/** Dial Desk status → stage guess (ported verbatim). */
export function guessStage(status: string | null | undefined): Stage {
  const s = String(status ?? "").toLowerCase().trim();
  if (!s || /not called|^new$/.test(s)) return "new";
  if (/cancel|resched|no.?show/.test(s)) return "resched";
  if (/no answer|voicemail|^vm$|^na$/.test(s)) return "cycle";
  if (/nurtur|call ?back|follow/.test(s)) return "nurture";
  if (/show(ed)?$/.test(s) && !/no/.test(s)) return "showed";
  if (/book|^set$|sched/.test(s)) return "booked";
  if (/not qual|dnq|disqual/.test(s)) return "dnq";
  if (/do not call|dnc|remove/.test(s)) return "dnc";
  if (/lost|not interest/.test(s)) return "lost";
  return "new";
}

/** The key a status value is grouped under (case and spacing don't matter). */
export function statusKey(status: string): string {
  return status.replace(/\s+/g, " ").trim().toLowerCase();
}

export type StatusCount = { key: string; label: string; count: number; guess: Stage };

/** Each distinct status in the file with its row count, most common first. */
export function statusCounts(rows: Grid, statusCol: number | undefined): StatusCount[] {
  if (statusCol === undefined) return [];
  const by = new Map<string, StatusCount>();
  for (const row of rows) {
    if (isBlankRow(row)) continue;
    const label = cellText(row[statusCol]);
    const key = statusKey(label);
    const cur = by.get(key);
    if (cur) cur.count++;
    else by.set(key, { key, label: label || "(blank)", count: 1, guess: guessStage(label) });
  }
  return [...by.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

// ── Values ──────────────────────────────────────────────────────────────────

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function validDay(y: number, m: number, d: number): string | null {
  if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null; // Feb 30 and friends
  return `${y}-${pad(m)}-${pad(d)}`;
}

function clock(h: string | undefined, mi: string | undefined, ampm: string | undefined): string | null {
  if (h === undefined) return null;
  let hour = Number(h);
  const minute = mi === undefined ? 0 : Number(mi);
  const ap = ampm?.toLowerCase();
  if (ap) {
    if (hour < 1 || hour > 12) return null;
    if (ap.startsWith("p") && hour !== 12) hour += 12;
    if (ap.startsWith("a") && hour === 12) hour = 0;
  }
  if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) return null;
  return `${pad(hour)}:${pad(minute)}`;
}

function fullYear(y: string): number {
  const n = Number(y);
  return y.length <= 2 ? 2000 + n : n;
}

// The optional time after a date. Anything after it (a zone, "- left VM") is ignored.
const TIME_TAIL = /(?!\d)(?:[ T,]+(?:at\s+)?(\d{1,2})(?::(\d{2}))?(?::\d{2}(?:\.\d+)?)?\s*([ap]\.?m\.?)?(?![\d:]))?/i;

/**
 * A wall-clock date (and maybe time) from a cell, read the way a US clinic
 * writes it: 11/13/2026, 2026-11-13, Nov 13 2026, 13-Nov-26, with or without
 * "2:30 PM". Excel date cells and Excel serial numbers work too. No time zone
 * is applied; the server reads it as clinic time.
 */
export function parseDateCell(v: Cell): { day: string; time: string | null } | null {
  if (v == null || typeof v === "boolean") return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const w = utcWallClock(v);
    if (!validDay(Number(w.day.slice(0, 4)), Number(w.day.slice(5, 7)), Number(w.day.slice(8, 10)))) return null;
    return { day: w.day, time: w.time === "00:00" ? null : w.time };
  }
  const s = String(v).trim();
  if (!s) return null;
  // An Excel serial number that wasn't formatted as a date (1954–2119).
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial < 20000 || serial > 80000) return null;
    return parseDateCell(new Date(Math.round((serial - 25569) * 86400000)));
  }
  let m = new RegExp(`^(\\d{4})-(\\d{1,2})-(\\d{1,2})${TIME_TAIL.source}`, "i").exec(s);
  if (m) {
    const day = validDay(Number(m[1]), Number(m[2]), Number(m[3]));
    return day ? { day, time: clock(m[4], m[5], m[6]) } : null;
  }
  m = new RegExp(`^(\\d{1,2})[/.-](\\d{1,2})[/.-](\\d{2}|\\d{4})${TIME_TAIL.source}`, "i").exec(s);
  if (m) {
    const day = validDay(fullYear(m[3]), Number(m[1]), Number(m[2]));
    return day ? { day, time: clock(m[4], m[5], m[6]) } : null;
  }
  // "Nov 13, 2026", "Friday, November 13 2026 at 2 PM"
  m = new RegExp(
    `^(?:[a-z]+,?\\s+)?([a-z]{3,9})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})${TIME_TAIL.source}`,
    "i",
  ).exec(s);
  if (m) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    const day = mi < 0 ? null : validDay(Number(m[3]), mi + 1, Number(m[2]));
    return day ? { day, time: clock(m[4], m[5], m[6]) } : null;
  }
  // "13-Nov-2026", "13 Nov 26"
  m = new RegExp(`^(\\d{1,2})[\\s-]([a-z]{3,9})\\.?[\\s,-]+(\\d{2}|\\d{4})${TIME_TAIL.source}`, "i").exec(s);
  if (m) {
    const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    const day = mi < 0 ? null : validDay(fullYear(m[3]), mi + 1, Number(m[1]));
    return day ? { day, time: clock(m[4], m[5], m[6]) } : null;
  }
  return null;
}

/**
 * The first usable US number in a cell: drops extensions ("x12") and takes
 * the first of several numbers ("555-0100 / 555-0101"). Null unless 10 digits.
 */
export function parsePhone(v: Cell): string | null {
  if (v == null || typeof v === "boolean" || v instanceof Date) return null;
  const s = String(v);
  for (const part of s.split(/[,;/|&]|\bor\b|\band\b/i)) {
    const noExt = part.replace(/\s*(?:x|ext\.?|extension)\s*\d+\s*$/i, "");
    const n = normalizePhone(noExt);
    if (n && n.length === 10) return n;
  }
  return null;
}

export function parseEmail(v: Cell): string | null {
  const s = cellText(v).toLowerCase().replace(/^mailto:/, "");
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 254 ? s : null;
}

const NO_WORDS = new Set([
  "", "n", "no", "false", "f", "0", "none", "-", "--", "n/a", "na", "null", "unchecked", "declined", "unknown",
  "opted out", "opt out", "opt-out", "not given", "no consent",
]);
const YES_WORDS = new Set([
  "y", "yes", "true", "t", "x", "1", "✓", "✔", "checked", "agreed", "agree", "consent", "consented", "given",
  "opted in", "opt in", "opt-in", "signed", "ok", "accepted",
]);

/** Consent cell: yes / true / x / a date ⇒ agreed (with that date if given). */
export function parseConsent(v: Cell): { consent: boolean; day: string | null } {
  if (v === true) return { consent: true, day: null };
  if (v == null || v === false) return { consent: false, day: null };
  const t = cellText(v).toLowerCase();
  if (NO_WORDS.has(t)) return { consent: false, day: null };
  const date = parseDateCell(v);
  if (date) return { consent: true, day: date.day };
  if (YES_WORDS.has(t) || /^(yes|agreed|consented)\b/.test(t)) return { consent: true, day: null };
  return { consent: false, day: null };
}

const PRIORITY_NO = new Set([...NO_WORDS, "low", "normal", "standard", "regular"]);

/** Priority cell under a rule. */
export function parsePriority(v: Cell, rule: PriorityRule | undefined): boolean {
  const t = cellText(v).toLowerCase();
  if (rule?.mode === "contains") {
    const want = rule.text.trim().toLowerCase();
    return !!want && t.includes(want);
  }
  return !PRIORITY_NO.has(t);
}

const HONORIFIC = /^(mr|mrs|ms|miss|mx|dr)\.?\s+/i;

function tidyName(s: string): string {
  const t = s.replace(/\s+/g, " ").trim().replace(HONORIFIC, "");
  // ALL CAPS or all lower: title-case it so the desk reads naturally.
  if (t && (t === t.toUpperCase() || t === t.toLowerCase())) {
    return t.toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());
  }
  return t;
}

/** "Jane Doe" → Jane / Doe; "Doe, Jane" → Jane / Doe; "Jane" → Jane / null. */
export function splitName(full: string): { firstName: string | null; lastName: string | null } {
  const s = full.replace(/\s+/g, " ").trim();
  if (!s) return { firstName: null, lastName: null };
  if (s.includes(",")) {
    const [last, rest] = [s.slice(0, s.indexOf(",")), s.slice(s.indexOf(",") + 1)];
    const first = tidyName(rest);
    return { firstName: first || null, lastName: tidyName(last) || null };
  }
  const parts = tidyName(s).split(" ");
  return { firstName: parts[0] || null, lastName: parts.slice(1).join(" ") || null };
}

function clip(s: string | null | undefined, max: number): string | null {
  if (!s) return null;
  const t = s.trim();
  return t ? t.slice(0, max) : null;
}

// ── Rows the server imports ─────────────────────────────────────────────────

/** A real calendar day, YYYY-MM-DD (not 2026-02-30). */
function isRealDay(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return !!m && validDay(Number(m[1]), Number(m[2]), Number(m[3])) === s.slice(0, 10);
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDay);

/** One lead as sent to the import API. Checked again by the server. */
export const ImportRowSchema = z.strictObject({
  /** Position in the file, so leads keep the file's order. */
  index: z.number().int().min(0).max(1_000_000),
  /** 10 digits. */
  phone: z.string().regex(/^\d{10}$/),
  firstName: z.string().max(100).nullish(),
  lastName: z.string().max(100).nullish(),
  email: z.string().max(254).nullish(),
  /** The clinic's own status text. */
  status: z.string().max(200).nullish(),
  /** Stage picked for that status (staff imports). */
  stage: z.enum(STAGES).nullish(),
  /** Clinic-local day of the last call. */
  lastCalledDay: day.nullish(),
  /** Clinic-local wall time, YYYY-MM-DDTHH:mm. */
  appointment: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/)
    .refine(isRealDay)
    .nullish(),
  note: z.string().max(MAX_NOTE_LENGTH).nullish(),
  /** Only set when the file has a priority column. */
  priority: z.boolean().nullish(),
  consent: z.boolean().nullish(),
  consentDay: day.nullish(),
  externalId: z.string().max(100).nullish(),
  source: z.string().max(100).nullish(),
});
export type ImportRow = z.infer<typeof ImportRowSchema>;

export type NormalizeOptions = {
  columns: ColumnMap;
  priority?: PriorityRule;
  /** statusKey → stage. Values not listed use guessStage. */
  statusMap?: Record<string, Stage>;
};

export type NormalizeStats = {
  /** Non-blank rows in the file. */
  rows: number;
  /** Distinct leads to import. */
  leads: number;
  /** Rows with no usable phone. */
  invalid: number;
  /** Rows whose phone appeared earlier in the file (merged into that row). */
  duplicates: number;
};

export type NormalizeResult = {
  rows: ImportRow[];
  stats: NormalizeStats;
  /** Sheet row numbers (1-based) of the first rows with no usable phone. */
  invalidRows: number[];
};

/** One sheet row → an ImportRow, or null when it has no usable phone. */
export function normalizeRow(row: Cell[], index: number, opts: NormalizeOptions): ImportRow | null {
  const c = opts.columns;
  const at = (f: ImportField): Cell => (c[f] === undefined ? undefined : row[c[f]!]);
  const phone = parsePhone(at("phone"));
  if (!phone) return null;

  let firstName = clip(tidyName(cellText(at("firstName"))), 100);
  let lastName = clip(tidyName(cellText(at("lastName"))), 100);
  if (c.fullName !== undefined) {
    const split = splitName(cellText(at("fullName")));
    firstName = firstName ?? clip(split.firstName, 100);
    lastName = lastName ?? clip(split.lastName, 100);
  }

  const statusText = clip(cellText(at("status")), 200);
  // A blank status can be given a stage too ("(blank)" in the status table).
  const stage = statusText
    ? (opts.statusMap?.[statusKey(statusText)] ?? guessStage(statusText))
    : c.status !== undefined
      ? (opts.statusMap?.[""] ?? null)
      : null;
  const last = c.lastCalled === undefined ? null : parseDateCell(at("lastCalled"));
  const appt = c.appointment === undefined ? null : parseDateCell(at("appointment"));
  const consent = c.consent === undefined ? null : parseConsent(at("consent"));

  return {
    index,
    phone,
    firstName,
    lastName,
    email: c.email === undefined ? null : parseEmail(at("email")),
    status: statusText,
    stage,
    lastCalledDay: last?.day ?? null,
    // A date with no time is read as noon, like the last-called date.
    appointment: appt ? `${appt.day}T${appt.time ?? "12:00"}` : null,
    note: clip(multilineText(at("note")), MAX_NOTE_LENGTH),
    priority: c.priority === undefined ? null : parsePriority(at("priority"), opts.priority),
    consent: consent ? consent.consent : null,
    consentDay: consent?.day ?? null,
    externalId: clip(cellText(at("externalId")), 100),
    source: clip(cellText(at("source")), 100),
  };
}

function joinNotes(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b || a.includes(b)) return a;
  return `${a}\n${b}`.slice(0, MAX_NOTE_LENGTH);
}

/**
 * Merge a later row for the same phone into the first one: the first row's
 * values win, its blanks are filled, notes are combined, and priority or
 * consent on either row counts.
 */
export function mergeRows(first: ImportRow, later: ImportRow): ImportRow {
  const out: ImportRow = { ...first };
  for (const k of [
    "firstName", "lastName", "email", "status", "stage", "lastCalledDay", "appointment", "externalId", "source",
  ] as const) {
    if (out[k] == null || out[k] === "") (out as Record<string, unknown>)[k] = later[k] ?? null;
  }
  // The status's stage travels with the status it came from.
  if (!first.status && later.status) out.stage = later.stage ?? null;
  out.note = joinNotes(first.note, later.note);
  if (first.priority != null || later.priority != null) out.priority = !!(first.priority || later.priority);
  if (first.consent != null || later.consent != null) out.consent = !!(first.consent || later.consent);
  if (out.consent) out.consentDay = first.consent ? (first.consentDay ?? later.consentDay ?? null) : (later.consentDay ?? null);
  return out;
}

/** Merge rows that share a phone, keeping the first one's place. */
export function dedupeRows(rows: ImportRow[]): { rows: ImportRow[]; duplicates: number } {
  const byPhone = new Map<string, number>();
  const out: ImportRow[] = [];
  let duplicates = 0;
  for (const r of rows) {
    const at = byPhone.get(r.phone);
    if (at === undefined) {
      byPhone.set(r.phone, out.length);
      out.push(r);
    } else {
      out[at] = mergeRows(out[at], r);
      duplicates++;
    }
  }
  return { rows: out, duplicates };
}

/**
 * Every data row of a sheet → the leads to import. Blank rows are skipped
 * without counting; rows without a 10-digit phone are counted as invalid;
 * repeated phones are merged into the first row with that phone.
 */
export function normalizeRows(data: Grid, opts: NormalizeOptions, headerRow = 0): NormalizeResult {
  const valid: ImportRow[] = [];
  const invalidRows: number[] = [];
  let rows = 0;
  let invalid = 0;
  data.forEach((row, i) => {
    if (isBlankRow(row)) return;
    rows++;
    const r = normalizeRow(row, i, opts);
    if (r) valid.push(r);
    else {
      invalid++;
      if (invalidRows.length < 5) invalidRows.push(headerRow + i + 2);
    }
  });
  const merged = dedupeRows(valid);
  return {
    rows: merged.rows,
    stats: { rows, leads: merged.rows.length, invalid, duplicates: merged.duplicates },
    invalidRows,
  };
}

/** The first `limit` non-blank rows, normalized, for the mapping preview. */
export function previewRows(
  data: Grid,
  opts: NormalizeOptions,
  headerRow = 0,
  limit = 10,
): { sheetRow: number; row: ImportRow | null }[] {
  const out: { sheetRow: number; row: ImportRow | null }[] = [];
  for (let i = 0; i < data.length && out.length < limit; i++) {
    if (isBlankRow(data[i])) continue;
    out.push({ sheetRow: headerRow + i + 2, row: normalizeRow(data[i], i, opts) });
  }
  return out;
}

/** A lead from a CRM, before normalization. Phones are tried in order. */
export type LeadRecord = {
  externalId?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  phones: (string | null | undefined)[];
  email?: string | null;
  status?: string | null;
  note?: string | null;
  source?: string | null;
};

/** A CRM record → an ImportRow (same rules as a sheet row), or null without a phone. */
export function normalizeRecord(rec: LeadRecord, index: number): ImportRow | null {
  let phone: string | null = null;
  for (const p of rec.phones) {
    phone = parsePhone(p ?? null);
    if (phone) break;
  }
  if (!phone) return null;
  let firstName = clip(tidyName(rec.firstName ?? ""), 100);
  let lastName = clip(tidyName(rec.lastName ?? ""), 100);
  if (!firstName && !lastName && rec.fullName) {
    const split = splitName(rec.fullName);
    firstName = clip(split.firstName, 100);
    lastName = clip(split.lastName, 100);
  }
  const status = clip(rec.status ?? null, 200);
  return {
    index,
    phone,
    firstName,
    lastName,
    email: rec.email ? parseEmail(rec.email) : null,
    status,
    stage: status ? guessStage(status) : null,
    lastCalledDay: null,
    appointment: null,
    note: clip(rec.note ?? null, MAX_NOTE_LENGTH),
    priority: null,
    consent: null,
    consentDay: null,
    externalId: clip(rec.externalId ?? null, 100),
    source: clip(rec.source ?? null, 100),
  };
}

/** Split rows into request-sized chunks. */
export function chunk<T>(items: T[], size = CHUNK_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ── What gets saved about an import (no row data) ──────────────────────────

export const IMPORT_SOURCES = ["csv", "xlsx", "zenoti", "mindbody", "aesthetic_record"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

/** The mapping summary stored on LeadImport.mapping: column titles and status labels only. */
export const MappingSummarySchema = z.strictObject({
  sheet: z.string().max(100).nullish(),
  headerRow: z.number().int().min(0).max(1000).nullish(),
  columns: z.partialRecord(z.enum(IMPORT_FIELDS), z.string().max(100)).optional(),
  statuses: z
    .record(z.string().max(60), z.enum(STAGES))
    .refine((r) => Object.keys(r).length <= 40)
    .optional(),
  priorityText: z.string().max(60).nullish(),
});
export type MappingSummary = z.infer<typeof MappingSummarySchema>;

/**
 * Build the mapping summary. Status labels are kept only when they look like
 * labels (short, and the 40 most common), so a free-text column can't carry
 * notes into it.
 */
export function mappingSummary(input: {
  sheet?: string | null;
  headerRow?: number | null;
  headers: string[];
  columns: ColumnMap;
  statuses?: StatusCount[];
  statusMap?: Record<string, Stage>;
  priority?: PriorityRule;
}): MappingSummary {
  const columns: Partial<Record<ImportField, string>> = {};
  for (const f of IMPORT_FIELDS) {
    const i = input.columns[f];
    if (i !== undefined && input.headers[i] !== undefined) columns[f] = input.headers[i].slice(0, 100);
  }
  const statuses: Record<string, Stage> = {};
  for (const s of (input.statuses ?? []).slice(0, 40)) {
    if (s.key.length > 60) continue;
    statuses[s.key] = input.statusMap?.[s.key] ?? s.guess;
  }
  return {
    sheet: input.sheet ? input.sheet.slice(0, 100) : null,
    headerRow: input.headerRow ?? null,
    columns,
    statuses,
    priorityText: input.priority?.mode === "contains" ? input.priority.text.slice(0, 60) : null,
  };
}
