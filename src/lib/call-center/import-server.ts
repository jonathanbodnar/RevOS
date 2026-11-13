/**
 * Server side of the lead import: writes one chunk of normalized rows into a
 * clinic's leads. Used by the staff import page, the clinic connect link and
 * CRM syncs, so every path dedupes and initializes leads the same way.
 *
 * Rules (see docs/call-center-import.md):
 *  - One lead per (clinic, phone). Rows for a phone the clinic already has
 *    update that lead instead of adding one.
 *  - New leads start the way the Dial Desk's makeContact started them, using
 *    the clinic's call rules and clinic-local days.
 *  - An existing lead only gets blanks filled, its priority (when the file has
 *    a priority column), consent if it had none, and new notes appended. Its
 *    stage changes only when the importer asks for it AND nobody has worked
 *    the lead on the desk yet. "Do not call" is the exception: it always
 *    sticks, and an import never takes a lead out of it.
 *  - A phone that belongs to a patient of the clinic links the lead to that
 *    patient, and a new lead starts as "Showed" so the desk never cold-calls
 *    a current patient.
 */
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../prisma";
import { decryptField, encryptField, isDecryptFailure } from "../encryption";
import { logAudit } from "../audit";
import { loadRules } from "./access";
import type { CallRulesConfig } from "./rules";
import type { Stage } from "./stages";
import { addWorkDays, dayInTz, zonedTimeToUtc } from "./time";
import {
  CHUNK_SIZE,
  dedupeRows,
  guessStage,
  ImportRowSchema,
  MappingSummarySchema,
  MAX_IMPORT_ROWS,
  MAX_NOTE_LENGTH,
  type ImportRow,
  type ImportSource,
} from "./import";

/** Longest a lead's running note may grow through imports. */
const MAX_LEAD_NOTE = 4000;
const LOST_REASON = "From sheet";

export type ImportOptions = {
  /** "These leads agreed in writing to be called." */
  consentAll: boolean;
  /** "Update statuses from this file." */
  updateStatuses: boolean;
  /** The file had a priority column, so existing leads' priority follows it. */
  priorityMapped: boolean;
  /** Ignore any stage sent with the rows and guess it from the status text. */
  guessStages?: boolean;
};

export type ImportContext = {
  clinicId: string;
  importId: string;
  /** LeadImport.createdAt. New leads are stamped from it in file order. */
  importStartedAt: Date;
  /** Lead.source: csv | xlsx | zenoti | mindbody | aesthetic_record. */
  source: ImportSource;
  /** Lead.consentSource for consent taken from this import. */
  consentSource: string;
  actorId: string | null;
  options: ImportOptions;
  /** Injected in tests. */
  now?: Date;
  rules?: CallRulesConfig;
};

export type ChunkCounts = {
  /** Rows received in this chunk. */
  received: number;
  created: number;
  updated: number;
  /** Nothing new, or a repeat of a phone already in this chunk. */
  skipped: number;
  /** Failed validation (no 10-digit phone, bad field). */
  invalid: number;
  /** Rows whose phone belongs to a patient of the clinic. */
  patients: number;
};

export function emptyCounts(): ChunkCounts {
  return { received: 0, created: 0, updated: 0, skipped: 0, invalid: 0, patients: 0 };
}

/** consentSource text for an import: "import:<file name>" or "import:<provider>". */
export function consentSourceFor(source: ImportSource, fileName: string | null | undefined): string {
  const what = source === "csv" || source === "xlsx" ? (fileName || source) : source;
  return `import:${what}`.slice(0, 200);
}

/**
 * The stage fields a lead starts with (Dial Desk makeContact):
 *  - "No answer" (cycle): one try used; next try `spacingDays` work days after
 *    the last call, never before today; today when there's no last call.
 *  - "Call back" and "Rebook": due today.
 *  - "Lost": reason "From sheet".
 */
export function initialStageFields(
  stage: Stage,
  lastCalledDay: string | null,
  today: string,
  rules: Pick<CallRulesConfig, "spacingDays" | "workDays">,
): { stage: Stage; attempts: number; nextDueDay: string | null; lostReason: string | null } {
  if (stage === "cycle") {
    const due = lastCalledDay ? addWorkDays(lastCalledDay, rules.spacingDays, rules.workDays) : today;
    return { stage, attempts: 1, nextDueDay: due > today ? due : today, lostReason: null };
  }
  if (stage === "nurture" || stage === "resched") {
    return { stage, attempts: 0, nextDueDay: today, lostReason: null };
  }
  return { stage, attempts: 0, nextDueDay: null, lostReason: stage === "lost" ? LOST_REASON : null };
}

/** The note text a row adds: its lead source (when given) and its notes. */
export function rowNote(row: ImportRow): string | null {
  const parts = [row.source ? `Source: ${row.source}` : null, row.note || null].filter(Boolean) as string[];
  return parts.length ? parts.join("\n").slice(0, MAX_NOTE_LENGTH) : null;
}

type Existing = {
  id: string;
  phone: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  externalId: string | null;
  priority: boolean;
  stage: string;
  lastNote: string | null;
  customerId: string | null;
  consentAt: Date | null;
  /** Desk activity (anything that isn't an import); one row is enough to know. */
  activities: { id: string }[];
};

/** Patients of the clinic by normalized phone (Customer.phone may be formatted). */
async function patientsByPhone(clinicId: string, phones: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (!phones.length) return out;
  // Same normalization as InBody pairing (inbody-ingest.ts): last 10 digits.
  const rows = await prisma.$queryRaw<{ id: string; phone: string }[]>(Prisma.sql`
    SELECT id, right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) AS phone
    FROM "Customer"
    WHERE "clinicId" = ${clinicId}
      AND right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) IN (${Prisma.join(phones)})
  `);
  for (const r of rows) {
    const ids = out.get(r.phone) ?? [];
    ids.push(r.id);
    out.set(r.phone, ids);
  }
  return out;
}

function noonUtc(day: string, tz: string): Date | null {
  return zonedTimeToUtc(`${day}T12:00`, tz);
}

/**
 * Write one chunk (≤ CHUNK_SIZE rows) into the clinic's leads and add its
 * counts to the LeadImport. Rows that fail validation are counted, not thrown.
 */
export async function importRows(ctx: ImportContext, input: unknown[]): Promise<ChunkCounts> {
  if (input.length > CHUNK_SIZE) throw new Error(`At most ${CHUNK_SIZE} rows per chunk.`);
  const counts = emptyCounts();
  counts.received = input.length;

  const valid: ImportRow[] = [];
  for (const raw of input) {
    const parsed = ImportRowSchema.safeParse(raw);
    if (!parsed.success) {
      counts.invalid++;
      continue;
    }
    const row = parsed.data;
    if (ctx.options.guessStages) row.stage = row.status ? guessStage(row.status) : null;
    valid.push(row);
  }
  const { rows, duplicates } = dedupeRows(valid);
  counts.skipped += duplicates;

  if (rows.length) {
    const now = ctx.now ?? new Date();
    const rules = ctx.rules ?? (await loadRules(ctx.clinicId));
    await writeRows(ctx, rows, counts, now, rules);
  }

  await prisma.leadImport.update({
    where: { id: ctx.importId },
    data: {
      rowsTotal: { increment: counts.received },
      created: { increment: counts.created },
      updated: { increment: counts.updated },
      skipped: { increment: counts.skipped },
      invalid: { increment: counts.invalid },
    },
  });
  return counts;
}

async function writeRows(
  ctx: ImportContext,
  rows: ImportRow[],
  counts: ChunkCounts,
  now: Date,
  rules: CallRulesConfig,
) {
  const tz = rules.timezone;
  const today = dayInTz(now, tz);
  const phones = rows.map((r) => r.phone);

  const [existingRows, patients] = await Promise.all([
    prisma.lead.findMany({
      where: { clinicId: ctx.clinicId, phone: { in: phones } },
      select: {
        id: true,
        phone: true,
        firstName: true,
        lastName: true,
        email: true,
        externalId: true,
        priority: true,
        stage: true,
        lastNote: true,
        customerId: true,
        consentAt: true,
        activities: { where: { kind: { not: "import" } }, select: { id: true }, take: 1 },
      },
    }) as Promise<Existing[]>,
    patientsByPhone(ctx.clinicId, phones),
  ]);
  const existing = new Map(existingRows.map((l) => [l.phone, l]));

  const consentFor = (row: ImportRow): Date | null => {
    if (!row.consent && !ctx.options.consentAll) return null;
    const given = row.consent && row.consentDay ? noonUtc(row.consentDay, tz) : null;
    // Consent can't be dated after the import.
    return given && given < now ? given : now;
  };

  const creates: Prisma.LeadCreateManyInput[] = [];
  const createNotes = new Map<string, string | null>();
  const activities: Prisma.LeadActivityCreateManyInput[] = [];
  const activity = (leadId: string, outcome: "imported" | "status", note: string | null) =>
    activities.push({
      leadId,
      clinicId: ctx.clinicId,
      userId: ctx.actorId,
      at: now,
      day: today,
      kind: "import",
      outcome,
      note: note ? encryptField(note) : null,
    });

  for (const row of rows) {
    const patientIds = patients.get(row.phone) ?? [];
    const isPatient = patientIds.length > 0;
    // Link only an unambiguous match; two patients sharing a phone (family)
    // still counts as "already a patient" but links neither.
    const patientId = patientIds.length === 1 ? patientIds[0] : null;
    if (isPatient) counts.patients++;

    // Calls can't have happened after today.
    const lastCalledDay = row.lastCalledDay && row.lastCalledDay > today ? today : (row.lastCalledDay ?? null);
    const apptAt = row.appointment ? zonedTimeToUtc(row.appointment, tz) : null;
    const note = rowNote(row);
    const lead = existing.get(row.phone);

    if (!lead) {
      const stage = startStage(row, isPatient, apptAt, now);
      const init = initialStageFields(stage, lastCalledDay, today, rules);
      const consentAt = consentFor(row);
      creates.push({
        clinicId: ctx.clinicId,
        phone: row.phone,
        firstName: row.firstName ?? null,
        lastName: row.lastName ?? null,
        email: row.email ?? null,
        ...init,
        priority: !!row.priority,
        lastCalledAt: lastCalledDay ? noonUtc(lastCalledDay, tz) : null,
        apptAt,
        lastNote: note ? encryptField(note) : null,
        consentAt,
        consentSource: consentAt ? ctx.consentSource : null,
        source: ctx.source,
        externalId: row.externalId ?? null,
        sourceStatus: row.status ?? null,
        importId: ctx.importId,
        customerId: patientId,
        // Keeps the file's order: createdAt = import start + position in ms.
        createdAt: new Date(ctx.importStartedAt.getTime() + row.index),
      });
      createNotes.set(row.phone, note);
      continue;
    }

    const data: Prisma.LeadUncheckedUpdateInput = {};
    let statusChanged = false;
    if (!lead.firstName && row.firstName) data.firstName = row.firstName;
    if (!lead.lastName && row.lastName) data.lastName = row.lastName;
    if (!lead.email && row.email) data.email = row.email;
    if (!lead.externalId && row.externalId) data.externalId = row.externalId;
    if (ctx.options.priorityMapped && row.priority != null && row.priority !== lead.priority) {
      data.priority = row.priority;
    }
    if (!lead.customerId && patientId) data.customerId = patientId;
    if (!lead.consentAt) {
      const consentAt = consentFor(row);
      if (consentAt) {
        data.consentAt = consentAt;
        data.consentSource = ctx.consentSource;
      }
    }

    // Stage: never out of "Do not call"; always into it. Otherwise only for
    // leads the desk hasn't worked: a current patient still marked New moves
    // to Showed, and "Update statuses from this file" applies the file's stage.
    const deskTouched = lead.activities.length > 0;
    const patient = isPatient || !!lead.customerId;
    let nextStage: Stage | null = null;
    if (lead.stage !== "dnc") {
      if (row.stage === "dnc") nextStage = "dnc";
      else if (!deskTouched && patient && lead.stage === "new") nextStage = "showed";
      else if (!deskTouched && !patient && ctx.options.updateStatuses && row.status) {
        nextStage = startStage(row, false, apptAt, now);
      }
    }
    if (nextStage && nextStage !== lead.stage) {
      if (deskTouched) {
        // Only "Do not call" gets here: keep the desk's counters and dates.
        data.stage = nextStage;
      } else {
        Object.assign(data, initialStageFields(nextStage, lastCalledDay, today, rules));
        if (lastCalledDay) data.lastCalledAt = noonUtc(lastCalledDay, tz);
        if (apptAt) data.apptAt = apptAt;
      }
      if (row.status) data.sourceStatus = row.status;
      statusChanged = true;
    }

    let appended: string | null = null;
    if (note) {
      const current = decryptField(lead.lastNote);
      // An unreadable note is left alone: re-encrypting the placeholder would
      // destroy a note that's recoverable with the right key.
      if (!isDecryptFailure(current) && !(current ?? "").includes(note)) {
        const next = current ? `${current}\n${note}` : note;
        data.lastNote = encryptField(next.length > MAX_LEAD_NOTE ? next.slice(-MAX_LEAD_NOTE) : next);
        appended = note;
      }
    }

    if (!Object.keys(data).length) {
      counts.skipped++;
      continue;
    }
    await prisma.lead.update({ where: { id: lead.id }, data });
    counts.updated++;
    if (statusChanged) activity(lead.id, "status", null);
    if (appended) activity(lead.id, "imported", appended);
  }

  if (creates.length) {
    const made = await prisma.lead.createManyAndReturn({
      data: creates,
      skipDuplicates: true,
      select: { id: true, phone: true },
    });
    counts.created += made.length;
    // Another import inserted the same phone a moment ago.
    counts.skipped += creates.length - made.length;
    for (const m of made) activity(m.id, "imported", createNotes.get(m.phone) ?? null);
  }
  if (activities.length) await prisma.leadActivity.createMany({ data: activities });
}

/**
 * Stage for a lead this import starts: "Do not call" wins, then current
 * patients ("Showed"), then the file's stage, then "Booked" for a future
 * appointment with no status, else "New".
 */
function startStage(row: ImportRow, isPatient: boolean, apptAt: Date | null, now: Date): Stage {
  if (row.stage === "dnc") return "dnc";
  if (isPatient) return "showed";
  if (row.stage) return row.stage;
  if (!row.status && apptAt && apptAt > now) return "booked";
  return "new";
}

// ── One upload request (staff page and clinic link) ─────────────────────────

/** Largest request body the import routes read (500 rows with long notes). */
export const MAX_BODY_BYTES = 3 * 1024 * 1024;

/**
 * Read a JSON body without ever holding more than `maxBytes` of it: the
 * stream is cut off as soon as it passes the cap.
 */
export async function readJsonBody(
  req: Request,
  maxBytes = MAX_BODY_BYTES,
): Promise<{ ok: true; value: unknown } | { ok: false; status: number; error: string }> {
  const tooBig = { ok: false as const, status: 413, error: "Too much at once. Send at most 500 rows per request." };
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return tooBig;
  if (!req.body) return { ok: false, status: 400, error: "Invalid input" };
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return tooBig;
    }
    parts.push(value);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(parts).toString("utf8")) };
  } catch {
    return { ok: false, status: 400, error: "Invalid input" };
  }
}

const count = z.number().int().min(0).max(MAX_IMPORT_ROWS);

/** One request of a chunked file import. */
export const ImportChunkSchema = z.strictObject({
  /** Missing on the first chunk; the response carries the new id. */
  importId: z.string().min(1).max(40).optional(),
  source: z.enum(["csv", "xlsx"]),
  fileName: z.string().trim().min(1).max(200),
  /** First chunk: column titles and status labels used (no row data). */
  mapping: MappingSummarySchema.optional(),
  options: z.strictObject({
    consentAll: z.boolean(),
    updateStatuses: z.boolean().optional(),
    priorityMapped: z.boolean(),
  }),
  /** Validated row by row in importRows, so one bad row doesn't sink the chunk. */
  rows: z.array(z.unknown()).max(CHUNK_SIZE),
  /** Last chunk. */
  done: z.boolean(),
  /** Last chunk: rows the browser already set aside. */
  fileStats: z.strictObject({ invalid: count, duplicates: count }).optional(),
});
export type ImportChunk = z.infer<typeof ImportChunkSchema>;

export type ImportTotals = { rowsTotal: number; created: number; updated: number; skipped: number; invalid: number };

export type ChunkResponse =
  | { ok: true; importId: string; done: boolean; counts: ChunkCounts; totals: ImportTotals }
  | { ok: false; status: number; error: string; importId?: string };

const TOTALS_SELECT = { rowsTotal: true, created: true, updated: true, skipped: true, invalid: true } as const;

/**
 * Handle one chunk: start or continue the LeadImport, write the rows, and on
 * the last chunk add the browser's counts and mark it done. Clinic-link
 * imports never update existing leads' statuses, and their stages are guessed
 * on the server from the status text.
 */
export async function runImportChunk(args: {
  clinicId: string;
  via: "staff" | "clinic_link";
  actorId: string | null;
  actorRole: string;
  linkId: string | null;
  body: ImportChunk;
}): Promise<ChunkResponse> {
  const { body } = args;
  let imp: { id: string; source: string; fileName: string | null; createdAt: Date; rowsTotal: number; status: string };
  if (!body.importId) {
    imp = await prisma.leadImport.create({
      data: {
        clinicId: args.clinicId,
        source: body.source,
        fileName: body.fileName,
        via: args.via,
        createdById: args.actorId,
        linkId: args.linkId,
        mapping: body.mapping ?? undefined,
        status: "running",
      },
      select: { id: true, source: true, fileName: true, createdAt: true, rowsTotal: true, status: true },
    });
    await logAudit({
      actorId: args.actorId,
      actorRole: args.actorRole,
      clinicId: args.clinicId,
      action: "lead_import.start",
      targetType: "LeadImport",
      targetId: imp.id,
      metadata: { source: body.source, via: args.via, linkId: args.linkId },
    });
  } else {
    const found = await prisma.leadImport.findFirst({
      where: { id: body.importId, clinicId: args.clinicId, via: args.via, linkId: args.linkId },
      select: { id: true, source: true, fileName: true, createdAt: true, rowsTotal: true, status: true },
    });
    if (!found) return { ok: false, status: 404, error: "That import wasn't found. Start again." };
    if (found.status === "done") return { ok: false, status: 409, error: "This import already finished." };
    imp = found;
  }
  if (imp.rowsTotal + body.rows.length > MAX_IMPORT_ROWS) {
    return {
      ok: false,
      status: 413,
      importId: imp.id,
      error: `One import can hold ${MAX_IMPORT_ROWS.toLocaleString("en-US")} leads. Split the file and import the rest separately.`,
    };
  }
  if (imp.status === "failed") {
    await prisma.leadImport.update({ where: { id: imp.id }, data: { status: "running", error: null } });
  }

  const source = (imp.source === "xlsx" ? "xlsx" : "csv") as ImportSource;
  let counts: ChunkCounts;
  try {
    counts = await importRows(
      {
        clinicId: args.clinicId,
        importId: imp.id,
        importStartedAt: imp.createdAt,
        source,
        consentSource: consentSourceFor(source, imp.fileName),
        actorId: args.actorId,
        options: {
          consentAll: body.options.consentAll,
          updateStatuses: args.via === "staff" && !!body.options.updateStatuses,
          priorityMapped: body.options.priorityMapped,
          guessStages: args.via === "clinic_link",
        },
      },
      body.rows,
    );
  } catch (e) {
    console.error("[lead-import] chunk failed", imp.id, e);
    await prisma.leadImport
      .update({ where: { id: imp.id }, data: { status: "failed", error: "Stopped partway. Try again to finish." } })
      .catch(() => {});
    return { ok: false, status: 500, importId: imp.id, error: "Something went wrong saving these leads. Try again." };
  }

  let totals: ImportTotals;
  if (body.done) {
    const invalid = body.fileStats?.invalid ?? 0;
    const duplicates = body.fileStats?.duplicates ?? 0;
    totals = await prisma.leadImport.update({
      where: { id: imp.id },
      data: {
        rowsTotal: { increment: invalid + duplicates },
        invalid: { increment: invalid },
        skipped: { increment: duplicates },
        status: "done",
        finishedAt: new Date(),
        error: null,
      },
      select: TOTALS_SELECT,
    });
    await logAudit({
      actorId: args.actorId,
      actorRole: args.actorRole,
      clinicId: args.clinicId,
      action: "lead_import.finish",
      targetType: "LeadImport",
      targetId: imp.id,
      metadata: { source, via: args.via, linkId: args.linkId, ...totals },
    });
  } else {
    totals = (await prisma.leadImport.findUnique({ where: { id: imp.id }, select: TOTALS_SELECT })) ?? {
      rowsTotal: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      invalid: 0,
    };
  }
  return { ok: true, importId: imp.id, done: body.done, counts, totals };
}

export type ImportHistoryItem = {
  id: string;
  source: string;
  fileName: string | null;
  via: string;
  status: string;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  rowsTotal: number;
  created: number;
  updated: number;
  skipped: number;
  invalid: number;
};

/** A clinic's recent imports (counts only). */
export async function recentImports(clinicId: string, take = 20): Promise<ImportHistoryItem[]> {
  const rows = await prisma.leadImport.findMany({
    where: { clinicId },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      source: true,
      fileName: true,
      via: true,
      status: true,
      error: true,
      createdAt: true,
      finishedAt: true,
      ...TOTALS_SELECT,
    },
  });
  return rows.map((r) => ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  }));
}
