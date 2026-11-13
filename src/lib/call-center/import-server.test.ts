/**
 * Server import rules (src/lib/call-center/import-server.ts), run against an
 * isolated Prisma: every database call is a mock and anything unexpected
 * throws. Made-up people and 555-01xx numbers only.
 */
import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { prisma } from "../prisma";
import { isolatePrisma } from "../test-helpers/prisma";
import { decryptField, encryptField } from "../encryption";
import { DEFAULT_RULES } from "./rules";
import type { ImportRow } from "./import";
import {
  consentSourceFor,
  importRows,
  initialStageFields,
  runImportChunk,
  type ImportContext,
  type ImportChunk,
} from "./import-server";

process.env.FIELD_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

// Friday Nov 13, 2026, noon in Chicago.
const NOW = new Date("2026-11-13T18:00:00Z");
const RULES = { ...DEFAULT_RULES, timezone: "America/Chicago" };
const STARTED = new Date("2026-11-13T17:59:00Z");

type Existing = {
  id: string;
  phone: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  externalId?: string | null;
  priority?: boolean;
  stage?: string;
  lastNote?: string | null;
  customerId?: string | null;
  consentAt?: Date | null;
  activities?: { id: string }[];
};

let restore: () => void;
let created: Record<string, unknown>[];
let updates: { where: { id: string }; data: Record<string, unknown> }[];
let activities: Record<string, unknown>[];
let importUpdates: Record<string, unknown>[];
let rawQueries: { values: unknown[] }[];
let createLimit: number | null;

/** Install the database mocks importRows needs. */
function db(opts: { existing?: Existing[]; patients?: { id: string; phone: string }[] } = {}) {
  mock.method(prisma.lead, "findMany", async () =>
    (opts.existing ?? []).map((l) => ({
      firstName: null,
      lastName: null,
      email: null,
      externalId: null,
      priority: false,
      stage: "new",
      lastNote: null,
      customerId: null,
      consentAt: null,
      activities: [],
      ...l,
    })),
  );
  mock.method(prisma, "$queryRaw", async (sql: { values: unknown[] }) => {
    rawQueries.push(sql);
    return opts.patients ?? [];
  });
  // isolatePrisma doesn't stub createManyAndReturn; give the stub one.
  Reflect.set(prisma.lead, "createManyAndReturn", async (args: { data: Record<string, unknown>[] }) => {
    const data = createLimit === null ? args.data : args.data.slice(0, createLimit);
    created.push(...data);
    return data.map((d) => ({ id: `lead-${d.phone}`, phone: d.phone }));
  });
  mock.method(prisma.lead, "update", async (args: { where: { id: string }; data: Record<string, unknown> }) => {
    updates.push(args);
    return {};
  });
  mock.method(prisma.leadActivity, "createMany", async (args: { data: Record<string, unknown>[] }) => {
    activities.push(...args.data);
    return { count: args.data.length };
  });
  mock.method(prisma.leadImport, "update", async (args: { data: Record<string, unknown> }) => {
    importUpdates.push(args.data);
    return { rowsTotal: 0, created: 0, updated: 0, skipped: 0, invalid: 0 };
  });
}

function ctx(over: Partial<ImportContext> = {}): ImportContext {
  return {
    clinicId: "clinic-1",
    importId: "import-1",
    importStartedAt: STARTED,
    source: "xlsx",
    consentSource: "import:leads.xlsx",
    actorId: "agent-1",
    options: { consentAll: false, updateStatuses: false, priorityMapped: false },
    now: NOW,
    rules: RULES,
    ...over,
  };
}

const row = (phone: string, over: Partial<ImportRow> = {}): ImportRow => ({ index: 0, phone, ...over });
const byPhone = (phone: string) => created.find((c) => c.phone === phone) as Record<string, unknown>;

beforeEach(() => {
  restore = isolatePrisma();
  created = [];
  updates = [];
  activities = [];
  importUpdates = [];
  rawQueries = [];
  createLimit = null;
  mock.method(prisma.auditLog, "create", async () => ({}));
});
afterEach(() => {
  mock.restoreAll();
  restore();
});

test("stage start fields follow the Dial Desk (spacing in work days, never before today)", () => {
  const today = "2026-11-13"; // Friday
  assert.deepEqual(initialStageFields("cycle", "2026-11-10", today, RULES), {
    stage: "cycle",
    attempts: 1,
    nextDueDay: today,
    lostReason: null,
  });
  // Called Thursday: two work days later is Monday (Saturday isn't a work day).
  assert.equal(initialStageFields("cycle", "2026-11-12", today, RULES).nextDueDay, "2026-11-16");
  assert.equal(initialStageFields("cycle", null, today, RULES).nextDueDay, today);
  assert.deepEqual(initialStageFields("nurture", null, today, RULES), { stage: "nurture", attempts: 0, nextDueDay: today, lostReason: null });
  assert.equal(initialStageFields("resched", "2026-11-01", today, RULES).nextDueDay, today);
  assert.deepEqual(initialStageFields("lost", null, today, RULES), { stage: "lost", attempts: 0, nextDueDay: null, lostReason: "From sheet" });
  assert.deepEqual(initialStageFields("booked", null, today, RULES), { stage: "booked", attempts: 0, nextDueDay: null, lostReason: null });
});

test("new leads: stage fields, clinic-time dates, encrypted notes, file order, import activity", async () => {
  db();
  const counts = await importRows(ctx(), [
    row("5550100101", { index: 0, firstName: "Jane", lastName: "Doe", status: "No answer", stage: "cycle", lastCalledDay: "2026-11-12", note: "Asked about price", priority: true, source: "Facebook", externalId: "crm-1" }),
    row("5550100102", { index: 4, stage: "nurture", status: "Call back" }),
    row("5550100103", { index: 9, stage: "lost", status: "Not interested" }),
    row("5550100104", { index: 12, appointment: "2026-11-20T14:30" }),
    row("5550100105", { index: 15, stage: "cycle", lastCalledDay: "2026-12-01" }),
  ]);
  assert.deepEqual(counts, { received: 5, created: 5, updated: 0, skipped: 0, invalid: 0, patients: 0 });

  const jane = byPhone("5550100101");
  assert.equal(jane.clinicId, "clinic-1");
  assert.equal(jane.stage, "cycle");
  assert.equal(jane.attempts, 1);
  assert.equal(jane.nextDueDay, "2026-11-16");
  assert.deepEqual(jane.lastCalledAt, new Date("2026-11-12T18:00:00Z"), "noon in Chicago");
  assert.equal(jane.priority, true);
  assert.equal(jane.sourceStatus, "No answer");
  assert.equal(jane.source, "xlsx");
  assert.equal(jane.externalId, "crm-1");
  assert.equal(jane.importId, "import-1");
  assert.equal(jane.consentAt, null);
  assert.match(String(jane.lastNote), /^enc:v1:/);
  assert.equal(decryptField(jane.lastNote as string), "Source: Facebook\nAsked about price");
  assert.deepEqual(jane.createdAt, new Date(STARTED.getTime()));

  assert.equal(byPhone("5550100102").nextDueDay, "2026-11-13");
  assert.equal(byPhone("5550100103").lostReason, "From sheet");
  assert.equal(byPhone("5550100104").stage, "booked", "a future appointment with no status is booked");
  assert.deepEqual(byPhone("5550100104").apptAt, new Date("2026-11-20T20:30:00Z"));
  assert.equal(byPhone("5550100105").nextDueDay, "2026-11-17", "a last call dated in the future counts as today");
  assert.deepEqual(byPhone("5550100105").createdAt, new Date(STARTED.getTime() + 15));

  assert.equal(activities.length, 5);
  const a = activities.find((x) => x.leadId === "lead-5550100101")!;
  assert.equal(a.kind, "import");
  assert.equal(a.outcome, "imported");
  assert.equal(a.day, "2026-11-13");
  assert.equal(a.userId, "agent-1");
  assert.equal(decryptField(a.note as string), "Source: Facebook\nAsked about price");
  assert.deepEqual(importUpdates[0], {
    rowsTotal: { increment: 5 },
    created: { increment: 5 },
    updated: { increment: 0 },
    skipped: { increment: 0 },
    invalid: { increment: 0 },
  });
});

test("existing leads: blanks filled, priority only when mapped, note appended once, desk stage kept", async () => {
  const existing: Existing = {
    id: "L1",
    phone: "5550100101",
    lastName: "Doe",
    stage: "booked",
    lastNote: encryptField("Old note"),
    activities: [{ id: "call-1" }],
  };
  db({ existing: [existing] });
  const input = row("5550100101", { firstName: "Jane", lastName: "Smith", email: "jane@example.test", priority: true, note: "New note", status: "No answer", stage: "cycle" });
  const counts = await importRows(ctx({ options: { consentAll: false, updateStatuses: true, priorityMapped: true } }), [input]);
  assert.equal(counts.updated, 1);
  assert.equal(created.length, 0);
  const data = updates[0].data;
  assert.equal(updates[0].where.id, "L1");
  assert.equal(data.firstName, "Jane");
  assert.equal(data.lastName, undefined, "a name already on file is kept");
  assert.equal(data.email, "jane@example.test");
  assert.equal(data.priority, true);
  assert.equal(data.stage, undefined, "the desk already worked this lead");
  assert.equal(decryptField(data.lastNote as string), "Old note\nNew note");
  assert.deepEqual(
    activities.map((x) => [x.leadId, x.outcome, decryptField(x.note as string)]),
    [["L1", "imported", "New note"]],
  );

  // Same file again: the note is already there and nothing else is new.
  updates = [];
  db({ existing: [{ ...existing, firstName: "Jane", email: "jane@example.test", priority: true, lastNote: encryptField("Old note\nNew note") }] });
  const again = await importRows(ctx({ options: { consentAll: false, updateStatuses: true, priorityMapped: true } }), [input]);
  assert.deepEqual([again.updated, again.skipped], [0, 1]);
  assert.equal(updates.length, 0);

  // Without a priority column, priority isn't touched.
  db({ existing: [{ ...existing, priority: true }] });
  updates = [];
  await importRows(ctx(), [row("5550100101", { priority: false })]);
  assert.equal(updates.length, 0);
});

test("update statuses: only when ticked and only for leads nobody has worked", async () => {
  db({ existing: [{ id: "L2", phone: "5550100102", stage: "new" }] });
  await importRows(ctx(), [row("5550100102", { status: "Call back", stage: "nurture" })]);
  assert.equal(updates.length, 0, "not ticked: stage kept");

  db({ existing: [{ id: "L2", phone: "5550100102", stage: "new" }] });
  await importRows(ctx({ options: { consentAll: false, updateStatuses: true, priorityMapped: false } }), [
    row("5550100102", { status: "Call back", stage: "nurture" }),
  ]);
  assert.equal(updates[0].data.stage, "nurture");
  assert.equal(updates[0].data.nextDueDay, "2026-11-13");
  assert.equal(updates[0].data.sourceStatus, "Call back");
  assert.equal(activities.at(-1)?.outcome, "status");
});

test("Do not call always sticks, and an import never takes a lead out of it", async () => {
  db({
    existing: [
      { id: "L3", phone: "5550100103", stage: "booked", activities: [{ id: "call" }] },
      { id: "L4", phone: "5550100104", stage: "dnc" },
    ],
  });
  await importRows(ctx({ options: { consentAll: false, updateStatuses: true, priorityMapped: false } }), [
    row("5550100103", { status: "Remove", stage: "dnc", lastCalledDay: "2026-11-01" }),
    row("5550100104", { status: "New", stage: "new" }),
  ]);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], {
    where: { id: "L3" },
    data: { stage: "dnc", sourceStatus: "Remove" },
  }, "the desk's counters and dates are left alone");
});

test("patients: linked by normalized phone, new leads start as Showed, shared phones not linked", async () => {
  db({
    existing: [{ id: "L5", phone: "5550100113", stage: "new" }],
    patients: [
      { id: "cust-1", phone: "5550100111" },
      { id: "cust-2", phone: "5550100112" },
      { id: "cust-3", phone: "5550100112" },
      { id: "cust-4", phone: "5550100113" },
    ],
  });
  const counts = await importRows(ctx(), [
    row("5550100111", { index: 0, stage: "cycle", status: "No answer" }),
    row("5550100112", { index: 1 }),
    row("5550100113", { index: 2 }),
    row("5550100114", { index: 3, stage: "dnc", status: "DNC" }),
  ]);
  assert.equal(counts.patients, 3);
  assert.equal(byPhone("5550100111").stage, "showed");
  assert.equal(byPhone("5550100111").customerId, "cust-1");
  assert.equal(byPhone("5550100112").stage, "showed");
  assert.equal(byPhone("5550100112").customerId, null, "two patients share it: link neither");
  assert.equal(byPhone("5550100114").stage, "dnc");
  assert.deepEqual(updates[0], { where: { id: "L5" }, data: { customerId: "cust-4", stage: "showed", attempts: 0, nextDueDay: null, lostReason: null } });
  // One query per chunk, scoped to the clinic, with the chunk's phones.
  assert.equal(rawQueries.length, 1);
  assert.ok(rawQueries[0].values.includes("clinic-1"));
  assert.ok(rawQueries[0].values.includes("5550100114"));
});

test("invalid rows and repeats in a chunk are counted, not thrown", async () => {
  db();
  const counts = await importRows(ctx(), [
    row("5550100101", { index: 0, firstName: "Jane" }),
    { index: 1, phone: "555-0101" },
    "not a row",
    { index: 2, phone: { not: "" } },
    row("5550100101", { index: 3, lastName: "Doe" }),
  ]);
  assert.deepEqual(counts, { received: 5, created: 1, updated: 0, skipped: 1, invalid: 3, patients: 0 });
  assert.equal(byPhone("5550100101").lastName, "Doe", "repeat merged into the first row");
});

test("a phone another import just inserted counts as skipped", async () => {
  db();
  createLimit = 1;
  const counts = await importRows(ctx(), [row("5550100101", { index: 0 }), row("5550100102", { index: 1 })]);
  assert.deepEqual([counts.created, counts.skipped], [1, 1]);
  assert.equal(activities.length, 1);
});

test("consent: from the row or the importer's checkbox; never overwritten", async () => {
  db({ existing: [{ id: "L6", phone: "5550100106" }, { id: "L7", phone: "5550100107", consentAt: new Date("2026-01-01") }] });
  await importRows(ctx({ options: { consentAll: true, updateStatuses: false, priorityMapped: false } }), [
    row("5550100105", { index: 0 }),
    row("5550100108", { index: 1, consent: true, consentDay: "2026-10-01" }),
    row("5550100106", { index: 2 }),
    row("5550100107", { index: 3 }),
    row("5550100109", { index: 4, consent: true, consentDay: "2027-01-01" }),
  ]);
  assert.deepEqual(byPhone("5550100109").consentAt, NOW, "consent dated in the future counts as now");
  assert.deepEqual(byPhone("5550100105").consentAt, NOW);
  assert.equal(byPhone("5550100105").consentSource, "import:leads.xlsx");
  assert.deepEqual(byPhone("5550100108").consentAt, new Date("2026-10-01T17:00:00Z"), "noon Chicago (CDT)");
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { where: { id: "L6" }, data: { consentAt: NOW, consentSource: "import:leads.xlsx" } });
});

test("consent source names the file or the CRM", () => {
  assert.equal(consentSourceFor("xlsx", "Nov leads.xlsx"), "import:Nov leads.xlsx");
  assert.equal(consentSourceFor("csv", null), "import:csv");
  assert.equal(consentSourceFor("zenoti", "ignored"), "import:zenoti");
});

// ── runImportChunk ──

function chunkBody(over: Partial<ImportChunk> = {}): ImportChunk {
  return {
    source: "xlsx",
    fileName: "leads.xlsx",
    options: { consentAll: false, updateStatuses: true, priorityMapped: false },
    rows: [row("5550100101", { status: "Booked", stage: "nurture" })],
    done: false,
    ...over,
  };
}

function chunkDb() {
  db();
  mock.method(prisma.callRules, "findUnique", async () => null);
  mock.method(prisma.clinic, "findUnique", async () => ({ state: "TX" }));
  const createImport = mock.method(prisma.leadImport, "create", async (args: { data: Record<string, unknown> }) => ({
    id: "import-9",
    source: args.data.source,
    fileName: args.data.fileName,
    createdAt: STARTED,
    rowsTotal: 0,
    status: "running",
  }));
  mock.method(prisma.leadImport, "findUnique", async () => ({ rowsTotal: 1, created: 1, updated: 0, skipped: 0, invalid: 0 }));
  return { createImport };
}

test("first chunk starts a LeadImport with the mapping and returns its id", async () => {
  const { createImport } = chunkDb();
  const mapping = { columns: { phone: "Phone" }, statuses: { booked: "booked" as const } };
  const res = await runImportChunk({ clinicId: "clinic-1", via: "staff", actorId: "agent-1", actorRole: "CALL_AGENT", linkId: null, body: chunkBody({ mapping }) });
  assert.equal(res.ok, true);
  assert.equal(res.ok && res.importId, "import-9");
  assert.deepEqual(createImport.mock.calls[0].arguments[0].data, {
    clinicId: "clinic-1",
    source: "xlsx",
    fileName: "leads.xlsx",
    via: "staff",
    createdById: "agent-1",
    linkId: null,
    mapping,
    status: "running",
  });
  assert.equal(byPhone("5550100101").stage, "nurture", "staff imports use the stage picked in the status table");
});

test("clinic-link chunks guess stages on the server and continue only their own import", async () => {
  chunkDb();
  const find = mock.method(prisma.leadImport, "findFirst", async () => ({
    id: "import-9",
    source: "csv",
    fileName: "x.csv",
    createdAt: STARTED,
    rowsTotal: 10,
    status: "running",
  }));
  const res = await runImportChunk({
    clinicId: "clinic-1",
    via: "clinic_link",
    actorId: null,
    actorRole: "CLINIC_LINK",
    linkId: "link-1",
    body: chunkBody({ importId: "import-9" }),
  });
  assert.equal(res.ok, true);
  assert.deepEqual(find.mock.calls[0].arguments[0]?.where, { id: "import-9", clinicId: "clinic-1", via: "clinic_link", linkId: "link-1" });
  assert.equal(byPhone("5550100101").stage, "booked", "the sent stage is ignored; 'Booked' is guessed");
  assert.equal(byPhone("5550100101").source, "csv");
});

test("unknown, finished and oversized imports are refused before any row is written", async () => {
  chunkDb();
  mock.method(prisma.leadImport, "findFirst", async () => null);
  const base = { clinicId: "clinic-1", via: "staff" as const, actorId: "a", actorRole: "SUPER_ADMIN", linkId: null };
  const missing = await runImportChunk({ ...base, body: chunkBody({ importId: "nope" }) });
  assert.deepEqual([missing.ok, !missing.ok && missing.status], [false, 404]);

  mock.restoreAll();
  chunkDb();
  mock.method(prisma.leadImport, "findFirst", async () => ({ id: "i", source: "csv", fileName: null, createdAt: STARTED, rowsTotal: 0, status: "done" }));
  const finished = await runImportChunk({ ...base, body: chunkBody({ importId: "i" }) });
  assert.deepEqual([finished.ok, !finished.ok && finished.status], [false, 409]);

  mock.restoreAll();
  chunkDb();
  mock.method(prisma.leadImport, "findFirst", async () => ({ id: "i", source: "csv", fileName: null, createdAt: STARTED, rowsTotal: 50_000, status: "running" }));
  const big = await runImportChunk({ ...base, body: chunkBody({ importId: "i" }) });
  assert.deepEqual([big.ok, !big.ok && big.status], [false, 413]);
  assert.equal(created.length, 0);
});

test("the last chunk adds the browser's counts and marks the import done", async () => {
  chunkDb();
  mock.method(prisma.leadImport, "findFirst", async () => ({ id: "i", source: "xlsx", fileName: "f.xlsx", createdAt: STARTED, rowsTotal: 500, status: "failed" }));
  const audit = mock.method(prisma.auditLog, "create", async () => ({}));
  const res = await runImportChunk({
    clinicId: "clinic-1",
    via: "staff",
    actorId: "agent-1",
    actorRole: "CALL_AGENT",
    linkId: null,
    body: chunkBody({ importId: "i", done: true, fileStats: { invalid: 7, duplicates: 3 } }),
  });
  assert.equal(res.ok, true);
  // failed → running (resume), the chunk's counts, then the finish.
  assert.deepEqual(importUpdates[0], { status: "running", error: null });
  const finish = importUpdates.at(-1)!;
  assert.deepEqual(finish.rowsTotal, { increment: 10 });
  assert.deepEqual(finish.invalid, { increment: 7 });
  assert.deepEqual(finish.skipped, { increment: 3 });
  assert.equal(finish.status, "done");
  assert.ok(finish.finishedAt instanceof Date);
  const actions = audit.mock.calls.map((c) => (c.arguments[0] as { data: { action: string; metadata: string } }).data);
  assert.deepEqual(actions.map((a) => a.action), ["lead_import.finish"]);
  assert.doesNotMatch(actions[0].metadata, /5550100101/, "audit rows carry counts, never phones");
});

test("a failing chunk marks the import stopped and says to try again", async () => {
  chunkDb();
  mock.method(prisma.lead, "findMany", async () => {
    throw new Error("connection reset");
  });
  const errors = mock.method(console, "error", () => {});
  const res = await runImportChunk({ clinicId: "clinic-1", via: "staff", actorId: "a", actorRole: "SUPER_ADMIN", linkId: null, body: chunkBody() });
  assert.deepEqual([res.ok, !res.ok && res.status], [false, 500]);
  assert.equal(!res.ok && res.importId, "import-9");
  assert.equal(importUpdates.at(-1)?.status, "failed");
  assert.equal(errors.mock.callCount(), 1);
});
