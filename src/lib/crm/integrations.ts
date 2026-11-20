/**
 * Server side of clinic CRM connections: run connect steps, store credentials
 * encrypted, disconnect, and sync leads in batches through the same import
 * path as a file (import-server.ts). Used by the staff Import page and the
 * clinic connect link alike.
 *
 * Credentials never leave the server: IntegrationView is all a browser sees.
 * Errors are stored as short messages in lastError, never vendor bodies.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "../prisma";
import { DecryptionError, decryptSecret, encryptField } from "../encryption";
import { logAudit } from "../audit";
import { MAX_IMPORT_ROWS, normalizeRecord } from "../call-center/import";
import { consentSourceFor, emptyCounts, importRows, type ChunkCounts } from "../call-center/import-server";
import { adapterFor } from "./index";
import {
  CRM_PROVIDERS,
  CrmError,
  crmErrorStatus,
  type ConnectField,
  type ConnectStep,
  type Credentials,
  type CrmProvider,
} from "./types";

/** Leads pulled per sync request; the browser keeps calling until done. */
export const SYNC_BATCH = 500;

export type Via = "staff" | "clinic_link";

export type Actor = {
  via: Via;
  actorId: string | null;
  actorRole: string;
  /** The connect link used, for clinic_link calls. */
  linkId: string | null;
};

export type IntegrationStatus = "not_connected" | "pending" | "connected" | "error" | "disconnected";

/** What a browser may see about a connection. No credentials. */
export type IntegrationView = {
  provider: CrmProvider;
  label: string;
  status: IntegrationStatus;
  accountLabel: string | null;
  connectedVia: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  updatedAt: string | null;
  /** Why this connector can't be used yet, if so. */
  unavailable: string | null;
  connectFields: ConnectField[];
};

type Row = {
  id: string;
  provider: string;
  status: string;
  credentials: string | null;
  accountLabel: string | null;
  connectedVia: string | null;
  lastSyncAt: Date | null;
  lastError: string | null;
  updatedAt: Date;
};

function asStatus(s: string | undefined): IntegrationStatus {
  return s === "pending" || s === "connected" || s === "error" || s === "disconnected" ? s : "not_connected";
}

function toView(provider: CrmProvider, row: Row | null): IntegrationView {
  const adapter = adapterFor(provider);
  return {
    provider,
    label: adapter.label,
    status: asStatus(row?.status),
    accountLabel: row?.accountLabel ?? null,
    connectedVia: row?.connectedVia ?? null,
    lastSyncAt: row?.lastSyncAt?.toISOString() ?? null,
    lastError: row?.lastError ?? null,
    updatedAt: row?.updatedAt?.toISOString() ?? null,
    unavailable: adapter.unavailableReason(),
    connectFields: adapter.connectFields,
  };
}

const ROW_SELECT = {
  id: true,
  provider: true,
  status: true,
  credentials: true,
  accountLabel: true,
  connectedVia: true,
  lastSyncAt: true,
  lastError: true,
  updatedAt: true,
} as const;

function findRow(clinicId: string, provider: CrmProvider): Promise<Row | null> {
  return prisma.clinicIntegration.findUnique({
    where: { clinicId_provider: { clinicId, provider } },
    select: ROW_SELECT,
  });
}

/** Every connector for a clinic, connected or not. */
export async function integrationViews(clinicId: string): Promise<IntegrationView[]> {
  const rows = await prisma.clinicIntegration.findMany({ where: { clinicId }, select: ROW_SELECT });
  const by = new Map(rows.map((r) => [r.provider, r]));
  return CRM_PROVIDERS.map((p) => toView(p, by.get(p) ?? null));
}

function readCredentials(stored: string | null): Credentials | null {
  if (!stored) return null;
  try {
    const plain = decryptSecret(stored, "CRM credentials");
    const parsed = plain ? (JSON.parse(plain) as unknown) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: Credentials = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
    return out;
  } catch (e) {
    if (e instanceof DecryptionError) {
      throw new CrmError("RevOS can't read the saved connection. Connect again.", "auth");
    }
    return null;
  }
}

function storeCredentials(creds: Credentials | null): string | null {
  if (!creds) return null;
  // CRM keys reach patient data, so refuse to keep them in plaintext in production.
  if (process.env.NODE_ENV === "production" && !process.env.FIELD_ENCRYPTION_KEY) {
    throw new CrmError("RevOS can't store connection keys right now (encryption isn't set up).", "unavailable");
  }
  return encryptField(JSON.stringify(creds));
}

/**
 * Run one connect step. A connected account starts over when new first-step
 * input arrives (for example a replacement API key).
 */
export async function connectIntegration(args: {
  clinicId: string;
  provider: CrmProvider;
  input: Record<string, string>;
  actor: Actor;
}): Promise<{ view: IntegrationView; step: ConnectStep | null }> {
  const adapter = adapterFor(args.provider);
  const reason = adapter.unavailableReason();
  if (reason) throw new CrmError(reason, "unavailable");

  const row = await findRow(args.clinicId, args.provider);
  const pending = row?.status === "pending" ? readCredentials(row.credentials) : null;
  const outcome = await adapter.connect(args.input, pending);
  const credentials = storeCredentials(outcome.credentials);

  const data = {
    status: outcome.status,
    credentials,
    accountLabel: outcome.accountLabel,
    externalId: outcome.externalId,
    connectedVia: args.actor.via,
    lastError: null,
  };
  const saved = await prisma.clinicIntegration.upsert({
    where: { clinicId_provider: { clinicId: args.clinicId, provider: args.provider } },
    create: { clinicId: args.clinicId, provider: args.provider, ...data },
    update: data,
    select: ROW_SELECT,
  });
  await logAudit({
    actorId: args.actor.actorId,
    actorRole: args.actor.actorRole,
    clinicId: args.clinicId,
    action: outcome.status === "connected" ? "crm.connect" : "crm.connect_step",
    targetType: "ClinicIntegration",
    targetId: saved.id,
    metadata: { provider: args.provider, status: outcome.status, via: args.actor.via, linkId: args.actor.linkId },
  });
  return { view: toView(args.provider, saved), step: outcome.status === "pending" ? outcome.step : null };
}

/** Forget the credentials and stop syncing. Leads already imported stay. */
export async function disconnectIntegration(args: {
  clinicId: string;
  provider: CrmProvider;
  actor: Actor;
}): Promise<IntegrationView | null> {
  const row = await findRow(args.clinicId, args.provider);
  if (!row) return null;
  const saved = await prisma.clinicIntegration.update({
    where: { id: row.id },
    data: { status: "disconnected", credentials: null, lastError: null },
    select: ROW_SELECT,
  });
  await logAudit({
    actorId: args.actor.actorId,
    actorRole: args.actor.actorRole,
    clinicId: args.clinicId,
    action: "crm.disconnect",
    targetType: "ClinicIntegration",
    targetId: row.id,
    metadata: { provider: args.provider, via: args.actor.via },
  });
  return toView(args.provider, saved);
}

export type SyncResult = {
  importId: string;
  /** Send back to continue; null when the sync is done. */
  cursor: string | null;
  done: boolean;
  counts: ChunkCounts;
  totals: { rowsTotal: number; created: number; updated: number; skipped: number; invalid: number };
};

/**
 * Pull one batch of leads and import it. The first call (no importId) starts
 * a LeadImport and asks for leads changed since the last finished sync (with
 * a day of overlap); later calls pass the importId and cursor they got back.
 */
export async function syncIntegration(args: {
  clinicId: string;
  provider: CrmProvider;
  importId?: string | null;
  cursor?: string | null;
  actor: Actor;
}): Promise<SyncResult> {
  const adapter = adapterFor(args.provider);
  const reason = adapter.unavailableReason();
  if (reason) throw new CrmError(reason, "unavailable");
  const row = await findRow(args.clinicId, args.provider);
  if (!row || row.status !== "connected") throw new CrmError(`Connect ${adapter.label} first.`, "input");
  const creds = readCredentials(row.credentials);
  if (!creds) throw new CrmError(`Connect ${adapter.label} again.`, "auth");

  let imp: { id: string; createdAt: Date; rowsTotal: number; status: string };
  if (!args.importId) {
    imp = await prisma.leadImport.create({
      data: {
        clinicId: args.clinicId,
        source: args.provider,
        via: args.actor.via,
        createdById: args.actor.actorId,
        linkId: args.actor.linkId,
        status: "running",
      },
      select: { id: true, createdAt: true, rowsTotal: true, status: true },
    });
    await logAudit({
      actorId: args.actor.actorId,
      actorRole: args.actor.actorRole,
      clinicId: args.clinicId,
      action: "lead_import.start",
      targetType: "LeadImport",
      targetId: imp.id,
      metadata: { source: args.provider, via: args.actor.via, linkId: args.actor.linkId },
    });
  } else {
    const found = await prisma.leadImport.findFirst({
      where: { id: args.importId, clinicId: args.clinicId, source: args.provider, status: { in: ["running", "failed"] } },
      select: { id: true, createdAt: true, rowsTotal: true, status: true },
    });
    if (!found) throw new CrmError("That sync wasn't found. Start it again.", "input");
    if (found.status === "failed") {
      await prisma.leadImport.update({ where: { id: found.id }, data: { status: "running", error: null } });
    }
    imp = found;
  }

  const since = !args.importId && row.lastSyncAt ? new Date(row.lastSyncAt.getTime() - 86_400_000) : null;
  try {
    const fetched = await adapter.fetchLeads(creds, { since, limit: SYNC_BATCH, cursor: args.cursor ?? null });
    // Records with no usable phone go in as {} so the import counts them invalid.
    const rows = fetched.records.map((r, i) => normalizeRecord(r, fetched.startIndex + i) ?? {});
    const counts = rows.length
      ? await importRows(
          {
            clinicId: args.clinicId,
            importId: imp.id,
            importStartedAt: imp.createdAt,
            source: args.provider,
            consentSource: consentSourceFor(args.provider, null),
            actorId: args.actor.actorId,
            options: { consentAll: false, updateStatuses: false, priorityMapped: false },
          },
          rows,
        )
      : emptyCounts();

    const capped = imp.rowsTotal + counts.received >= MAX_IMPORT_ROWS;
    const done = !fetched.nextCursor || capped;
    const totals = await prisma.leadImport.update({
      where: { id: imp.id },
      data: done
        ? {
            status: "done",
            finishedAt: new Date(),
            error: capped && fetched.nextCursor ? `Stopped at ${MAX_IMPORT_ROWS.toLocaleString("en-US")} leads.` : null,
          }
        : {},
      select: { rowsTotal: true, created: true, updated: true, skipped: true, invalid: true },
    });
    if (done) {
      await prisma.clinicIntegration.update({
        where: { id: row.id },
        data: { lastSyncAt: imp.createdAt, lastError: null },
      });
      await logAudit({
        actorId: args.actor.actorId,
        actorRole: args.actor.actorRole,
        clinicId: args.clinicId,
        action: "lead_import.finish",
        targetType: "LeadImport",
        targetId: imp.id,
        metadata: { source: args.provider, via: args.actor.via, ...totals },
      });
    }
    return { importId: imp.id, cursor: done ? null : fetched.nextCursor, done, counts, totals };
  } catch (e) {
    const err = e instanceof CrmError ? e : new CrmError("The sync stopped partway. Try again.", "upstream");
    if (!(e instanceof CrmError)) console.error("[crm] sync failed", args.provider, e);
    await prisma.leadImport.update({ where: { id: imp.id }, data: { status: "failed", error: err.message } });
    await prisma.clinicIntegration.update({
      where: { id: row.id },
      data: { lastError: err.message, ...(err.kind === "auth" || err.kind === "pending" ? { status: "error" } : {}) },
    });
    throw err;
  }
}

// ── Request bodies and errors shared by the staff and clinic-link routes ────

/** POST …/integrations/[provider]: one connect step. */
export const ConnectBodySchema = z.strictObject({
  input: z
    .record(z.string().max(40), z.string().max(500))
    .refine((r) => Object.keys(r).length <= 10, "Too many fields."),
});

/** POST …/integrations/[provider]/sync: start (no importId) or continue a sync. */
export const SyncBodySchema = z.strictObject({
  importId: z.string().min(1).max(40).optional(),
  cursor: z.string().min(1).max(500).optional(),
});

/** A CrmError as an API response; anything else is logged and hidden. */
export function crmErrorResponse(e: unknown): NextResponse {
  if (e instanceof CrmError) return NextResponse.json({ error: e.message }, { status: crmErrorStatus(e) });
  console.error("[crm] request failed", e);
  return NextResponse.json({ error: "Something went wrong. Try again." }, { status: 500 });
}
