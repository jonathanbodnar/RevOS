/**
 * Lead import parsing and mapping (src/lib/call-center/import.ts). Every name
 * and number here is made up; phones use the 555-01xx fiction range.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chunk,
  dataRows,
  decodeText,
  dedupeRows,
  detectDelimiter,
  detectFileKind,
  guessColumns,
  guessHeaderRow,
  guessStage,
  headersFor,
  ImportFileError,
  ImportRowSchema,
  mappingSummary,
  normalizeRecord,
  normalizeRows,
  parseConsent,
  parseCsv,
  parseDateCell,
  parsePhone,
  parsePriority,
  previewRows,
  splitName,
  statusCounts,
  type ImportRow,
} from "./import";

// ── CSV ──

test("CSV: quotes, escaped quotes, embedded commas and line breaks", () => {
  const text = 'Name,Phone,Notes\r\n"Doe, Jane",555-010-0101,"Said ""call after 5""\r\nsecond line"\r\nAl Test,5550100102,\r\n';
  assert.deepEqual(parseCsv(text), [
    ["Name", "Phone", "Notes"],
    ["Doe, Jane", "555-010-0101", 'Said "call after 5"\r\nsecond line'],
    ["Al Test", "5550100102", ""],
  ]);
});

test("CSV: BOM, LF and lone CR line endings, no trailing newline", () => {
  assert.deepEqual(parseCsv("﻿a,b\nc,d"), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(parseCsv("a,b\rc,d\r"), [["a", "b"], ["c", "d"]]);
  assert.deepEqual(parseCsv(""), []);
  assert.deepEqual(parseCsv("a,b,"), [["a", "b", ""]]);
});

test("CSV: lenient about stray quotes and spaces before a quote", () => {
  assert.deepEqual(parseCsv('a, "b c",5\'10"\n'), [["a", "b c", "5'10\""]]);
  // An unclosed quote keeps the rest of the text in that field.
  assert.deepEqual(parseCsv('a,"open\nrest'), [["a", "open\nrest"]]);
});

test("CSV: delimiter detection for comma, semicolon (European Excel) and tab", () => {
  assert.equal(detectDelimiter("Name,Phone\nJane,5550100101\n"), ",");
  assert.equal(detectDelimiter("Name;Phone;Notes\n\"Doe, Jane\";5550100101;a, b\n"), ";");
  assert.equal(detectDelimiter("Name\tPhone\nDoe, Jane\t5550100101\n"), "\t");
  assert.equal(detectDelimiter("just one column\nvalue\n"), ",");
  assert.deepEqual(parseCsv("Name;Phone\nJane;5550100101"), [["Name", "Phone"], ["Jane", "5550100101"]]);
});

test("text decoding: UTF-8, Windows-1252 and UTF-16 exports", () => {
  assert.equal(decodeText(new TextEncoder().encode("José")), "José");
  assert.equal(decodeText(Uint8Array.from([0x4a, 0x6f, 0x73, 0xe9])), "José"); // cp1252 é
  assert.equal(decodeText(Uint8Array.from([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00])), "AB");
});

test("file kind: xlsx by zip signature, friendly errors for .xls and .numbers", () => {
  const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);
  const text = Uint8Array.from([0x4e, 0x61, 0x6d, 0x65]);
  assert.equal(detectFileKind("leads.xlsx", zip), "xlsx");
  assert.equal(detectFileKind("export", zip), "xlsx");
  assert.equal(detectFileKind("leads.csv", text), "csv");
  assert.throws(() => detectFileKind("old.xls", Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0])), ImportFileError);
  assert.throws(() => detectFileKind("leads.numbers", zip), /Numbers/);
  assert.throws(() => detectFileKind("broken.xlsx", text), ImportFileError);
});

// ── Header row and columns ──

test("header row: a title block above the headers is skipped", () => {
  const rows = [
    ["Downtown Med Spa leads", null],
    ["Exported 11/13/2026", null],
    [],
    ["First Name", "Last Name", "Mobile Phone", "Status"],
    ["Jane", "Doe", "5550100101", "New"],
  ];
  assert.equal(guessHeaderRow(rows), 3);
  assert.deepEqual(headersFor(rows, 3), ["First Name", "Last Name", "Mobile Phone", "Status"]);
  assert.deepEqual(dataRows(rows, 3), [["Jane", "Doe", "5550100101", "New"]]);
});

test("headers: blanks get column letters and repeats are numbered", () => {
  assert.deepEqual(headersFor([["Phone", "", "Phone"], ["1", "2", "3", "4"]], 0), [
    "Phone",
    "Column B",
    "Phone (2)",
    "Column D",
  ]);
});

test("column guess: Dial Desk sheet export", () => {
  const h = ["Name", "Phone Number", "Status", "Last Called", "Call Notes", "Tirzepatide", "Email"];
  const g = guessColumns(h);
  assert.deepEqual(g.columns, {
    fullName: 0,
    phone: 1,
    status: 2,
    lastCalled: 3,
    note: 4,
    priority: 5,
    email: 6,
  });
  assert.deepEqual(g.priority, { mode: "yes" });
});

test("column guess: CRM export with first/last names, several phones and ids", () => {
  const h = ["Client ID", "First Name", "Last Name", "Home Phone", "Mobile Phone", "E-mail", "Lead Source", "Tags"];
  const g = guessColumns(h);
  assert.equal(g.columns.firstName, 1);
  assert.equal(g.columns.lastName, 2);
  assert.equal(g.columns.fullName, undefined, "no full-name column when first name exists");
  assert.equal(g.columns.phone, 4, "mobile wins over home");
  assert.equal(g.columns.email, 5);
  assert.equal(g.columns.externalId, 0);
  assert.equal(g.columns.source, 6);
  assert.equal(g.columns.priority, 7);
  assert.deepEqual(g.priority, { mode: "contains", text: "" }, "tags need the text that marks priority");
});

test("column guess: consent only from explicit consent columns, appointment dates", () => {
  const g = guessColumns(["Patient", "Cell", "SMS Opt In", "TCPA Consent", "Appointment Date", "Appointment Status"]);
  assert.equal(g.columns.fullName, 0);
  assert.equal(g.columns.phone, 1);
  assert.equal(g.columns.consent, 3, "an SMS opt-in is not consent to be called");
  assert.equal(g.columns.appointment, 4);
  assert.equal(g.columns.status, 5);
});

// ── Status → stage ──

test("status → stage guess is the Dial Desk's", () => {
  const cases: [string, string][] = [
    ["", "new"],
    ["Not called", "new"],
    ["new", "new"],
    ["Cancelled", "resched"],
    ["Rescheduled", "resched"],
    ["No show", "resched"],
    ["No-Show", "resched"],
    ["No answer", "cycle"],
    ["Voicemail", "cycle"],
    ["VM", "cycle"],
    ["NA", "cycle"],
    ["Nurture", "nurture"],
    ["Call back", "nurture"],
    ["Callback Friday", "nurture"],
    ["Follow up", "nurture"],
    ["Showed", "showed"],
    ["Show", "showed"],
    ["Booked", "booked"],
    ["Set", "booked"],
    ["Scheduled", "booked"],
    ["Not qualified", "dnq"],
    ["DNQ", "dnq"],
    ["Do not call", "dnc"],
    ["DNC", "dnc"],
    ["Remove me", "dnc"],
    ["Lost", "lost"],
    ["Not interested", "lost"],
    ["Something else", "new"],
  ];
  for (const [status, stage] of cases) assert.equal(guessStage(status), stage, status);
});

test("status table: distinct values with counts, case-insensitive", () => {
  const rows = [["No Answer"], ["no answer"], ["Booked"], [""], [null], ["No Answer"]];
  const counts = statusCounts(rows, 0);
  assert.deepEqual(
    counts.map((c) => [c.key, c.label, c.count, c.guess]),
    [
      ["no answer", "No Answer", 3, "cycle"],
      ["booked", "Booked", 1, "booked"],
    ],
  );
  assert.deepEqual(statusCounts(rows, undefined), []);
});

// ── Values ──

test("phones: 10 digits after normalizing, extensions dropped, first of several", () => {
  assert.equal(parsePhone("(555) 010-0101"), "5550100101");
  assert.equal(parsePhone("+1 555 010 0101"), "5550100101");
  assert.equal(parsePhone("1-555-010-0101"), "5550100101");
  assert.equal(parsePhone(5550100101), "5550100101");
  assert.equal(parsePhone("555-010-0101 x12"), "5550100101");
  assert.equal(parsePhone("555-0101 / 555-010-0102"), "5550100102");
  assert.equal(parsePhone("555-0101"), null);
  assert.equal(parsePhone("call me"), null);
  assert.equal(parsePhone(""), null);
});

test("dates: US, ISO, month names, Excel dates and serials; bad dates rejected", () => {
  assert.deepEqual(parseDateCell("11/13/2026"), { day: "2026-11-13", time: null });
  assert.deepEqual(parseDateCell("11/3/26 2:30 PM"), { day: "2026-11-03", time: "14:30" });
  assert.deepEqual(parseDateCell("2026-11-13T09:05:00Z"), { day: "2026-11-13", time: "09:05" });
  assert.deepEqual(parseDateCell("Nov 13, 2026"), { day: "2026-11-13", time: null });
  assert.deepEqual(parseDateCell("Friday, November 13, 2026 at 3 pm"), { day: "2026-11-13", time: "15:00" });
  assert.deepEqual(parseDateCell("13-Nov-2026"), { day: "2026-11-13", time: null });
  assert.deepEqual(parseDateCell("11/13/2026 - left VM"), { day: "2026-11-13", time: null });
  // read-excel-file returns Excel wall-clock time in the Date's UTC fields.
  assert.deepEqual(parseDateCell(new Date(Date.UTC(2026, 10, 13, 16, 45))), { day: "2026-11-13", time: "16:45" });
  assert.deepEqual(parseDateCell("46339"), { day: "2026-11-13", time: null });
  assert.equal(parseDateCell("2/30/2026"), null);
  assert.equal(parseDateCell("13/13/2026"), null);
  assert.equal(parseDateCell("yesterday"), null);
  assert.equal(parseDateCell(true), null);
});

test("consent: yes / true / x / a date mean agreed", () => {
  assert.deepEqual(parseConsent("Yes"), { consent: true, day: null });
  assert.deepEqual(parseConsent("TRUE"), { consent: true, day: null });
  assert.deepEqual(parseConsent("x"), { consent: true, day: null });
  assert.deepEqual(parseConsent(true), { consent: true, day: null });
  assert.deepEqual(parseConsent("10/2/2026"), { consent: true, day: "2026-10-02" });
  assert.deepEqual(parseConsent("No"), { consent: false, day: null });
  assert.deepEqual(parseConsent(""), { consent: false, day: null });
  assert.deepEqual(parseConsent("maybe"), { consent: false, day: null });
});

test("priority: yes-like values, or Dial Desk priority text", () => {
  assert.equal(parsePriority("Yes", { mode: "yes" }), true);
  assert.equal(parsePriority("x", { mode: "yes" }), true);
  assert.equal(parsePriority("High", { mode: "yes" }), true);
  assert.equal(parsePriority("No", { mode: "yes" }), false);
  assert.equal(parsePriority("Low", { mode: "yes" }), false);
  assert.equal(parsePriority("", { mode: "yes" }), false);
  assert.equal(parsePriority("Weight loss, GLP-1", { mode: "contains", text: "glp-1" }), true);
  assert.equal(parsePriority("Botox", { mode: "contains", text: "GLP-1" }), false);
  assert.equal(parsePriority("GLP-1", { mode: "contains", text: " " }), false, "blank text marks nobody");
});

test("names: full names split, 'Last, First', caps tidied, honorifics dropped", () => {
  assert.deepEqual(splitName("Jane Doe"), { firstName: "Jane", lastName: "Doe" });
  assert.deepEqual(splitName("Doe, Jane"), { firstName: "Jane", lastName: "Doe" });
  assert.deepEqual(splitName("JANE ANN DOE"), { firstName: "Jane", lastName: "Ann Doe" });
  assert.deepEqual(splitName("dr. al o'test"), { firstName: "Al", lastName: "O'Test" });
  assert.deepEqual(splitName("Jane"), { firstName: "Jane", lastName: null });
  assert.deepEqual(splitName("  "), { firstName: null, lastName: null });
});

// ── Normalizing rows ──

const SHEET = [
  ["Name", "Phone", "Status", "Last Called", "Notes", "Tirzepatide", "Email"],
  ["Jane Doe", "(555) 010-0101", "No answer", "11/10/2026", "Asked about pricing", "yes", "JANE@EXAMPLE.TEST"],
  [],
  ["Al Test", "n/a", "New", "", "", "", ""],
  ["Doe, Jane", "555.010.0101", "Booked", "", "Prefers mornings", "", ""],
  ["Bo Sample", "+1 555 010 0103", "Do not call", "", "", "no", "not-an-email"],
];

test("normalize: blank rows skipped, invalid phones counted, repeats merged (first wins)", () => {
  const data = dataRows(SHEET, 0);
  const { columns, priority } = guessColumns(headersFor(SHEET, 0));
  const out = normalizeRows(data, { columns, priority }, 0);
  assert.deepEqual(out.stats, { rows: 4, leads: 2, invalid: 1, duplicates: 1 });
  assert.deepEqual(out.invalidRows, [4], "sheet row number of the row without a phone");
  const [jane, bo] = out.rows;
  assert.deepEqual(jane, {
    index: 0,
    phone: "5550100101",
    firstName: "Jane",
    lastName: "Doe",
    email: "jane@example.test",
    status: "No answer",
    stage: "cycle",
    lastCalledDay: "2026-11-10",
    appointment: null,
    note: "Asked about pricing\nPrefers mornings",
    priority: true,
    consent: null,
    consentDay: null,
    externalId: null,
    source: null,
  });
  assert.equal(bo.phone, "5550100103");
  assert.equal(bo.stage, "dnc");
  assert.equal(bo.email, null, "a bad email is dropped, the row is kept");
  assert.equal(bo.priority, false);
  for (const r of out.rows) assert.equal(ImportRowSchema.safeParse(r).success, true);
});

test("normalize: the status table overrides the guess, including for blank statuses", () => {
  const data = dataRows(SHEET, 0);
  const { columns } = guessColumns(headersFor(SHEET, 0));
  const out = normalizeRows(data, { columns, statusMap: { "no answer": "nurture", "do not call": "dnc" } });
  assert.equal(out.rows[0].stage, "nurture");
  const blank = normalizeRows([["5550100104", ""]], { columns: { phone: 0, status: 1 }, statusMap: { "": "cycle" } });
  assert.equal(blank.rows[0].stage, "cycle");
});

test("normalize: appointments keep wall time; a date alone is noon; consent dates kept", () => {
  const out = normalizeRows(
    [
      ["5550100105", "11/20/2026 2:30 PM", "Yes"],
      ["5550100106", "11/21/2026", "10/01/2026"],
    ],
    { columns: { phone: 0, appointment: 1, consent: 2 } },
  );
  assert.equal(out.rows[0].appointment, "2026-11-20T14:30");
  assert.equal(out.rows[0].consent, true);
  assert.equal(out.rows[1].appointment, "2026-11-21T12:00");
  assert.equal(out.rows[1].consentDay, "2026-10-01");
});

test("preview: first rows with sheet row numbers, invalid rows shown as null", () => {
  const data = dataRows(SHEET, 0);
  const { columns } = guessColumns(headersFor(SHEET, 0));
  const p = previewRows(data, { columns }, 0, 3);
  assert.deepEqual(p.map((x) => x.sheetRow), [2, 4, 5]);
  assert.equal(p[1].row, null);
});

test("merge: blanks filled from later rows, priority and consent from either", () => {
  const base: ImportRow = { index: 0, phone: "5550100107", firstName: "Jane", note: "a", priority: false };
  const { rows, duplicates } = dedupeRows([
    base,
    { index: 3, phone: "5550100107", firstName: "Janet", lastName: "Doe", note: "b", priority: true, consent: true, consentDay: "2026-10-01" },
  ]);
  assert.equal(duplicates, 1);
  assert.deepEqual(rows, [
    { ...base, lastName: "Doe", note: "a\nb", priority: true, consent: true, consentDay: "2026-10-01", email: null, status: null, stage: null, lastCalledDay: null, appointment: null, externalId: null, source: null },
  ]);
});

test("CRM records normalize like sheet rows", () => {
  assert.equal(normalizeRecord({ phones: [null, "bad"] }, 0), null);
  const r = normalizeRecord({ fullName: "Jane Doe", phones: ["", "(555) 010-0108"], email: "J@X.TEST", status: "Prospect", externalId: "g-1" }, 7);
  assert.equal(r?.phone, "5550100108");
  assert.equal(r?.firstName, "Jane");
  assert.equal(r?.email, "j@x.test");
  assert.equal(r?.stage, "new");
  assert.equal(r?.index, 7);
});

test("row schema rejects anything the server shouldn't store", () => {
  assert.equal(ImportRowSchema.safeParse({ index: 0, phone: "555010010" }).success, false);
  assert.equal(ImportRowSchema.safeParse({ index: 0, phone: { $ne: "" } }).success, false);
  assert.equal(ImportRowSchema.safeParse({ index: 0, phone: "5550100101", stage: "vip" }).success, false);
  assert.equal(ImportRowSchema.safeParse({ index: 0, phone: "5550100101", extra: 1 }).success, false);
  assert.equal(ImportRowSchema.safeParse({ index: 0, phone: "5550100101", note: "x".repeat(2001) }).success, false);
  assert.equal(ImportRowSchema.safeParse({ index: 0, phone: "5550100101", lastCalledDay: "2026-02-30" }).success, false);
  assert.equal(ImportRowSchema.safeParse({ index: 0, phone: "5550100101", appointment: "2026-11-20T25:00" }).success, false);
  assert.equal(ImportRowSchema.safeParse({ index: 0, phone: "5550100101", appointment: "2026-11-20T14:30" }).success, true);
  assert.equal(ImportRowSchema.safeParse({ index: 0, phone: "5550100101" }).success, true);
});

test("mapping summary keeps column titles and short status labels only", () => {
  const headers = ["Name", "Phone", "Status"];
  const statuses = [
    { key: "no answer", label: "No answer", count: 3, guess: "cycle" as const },
    { key: "x".repeat(61), label: "x".repeat(61), count: 1, guess: "new" as const },
  ];
  const m = mappingSummary({
    sheet: "Leads",
    headerRow: 0,
    headers,
    columns: { fullName: 0, phone: 1, status: 2 },
    statuses,
    statusMap: { "no answer": "nurture" },
    priority: { mode: "contains", text: "GLP-1" },
  });
  assert.deepEqual(m, {
    sheet: "Leads",
    headerRow: 0,
    columns: { fullName: "Name", phone: "Phone", status: "Status" },
    statuses: { "no answer": "nurture" },
    priorityText: "GLP-1",
  });
});

test("chunks are at most 500 rows", () => {
  const parts = chunk(Array.from({ length: 1201 }, (_, i) => i));
  assert.deepEqual(parts.map((p) => p.length), [500, 500, 201]);
});
