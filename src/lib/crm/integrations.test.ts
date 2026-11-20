/**
 * CRM connections on the server (src/lib/crm/integrations.ts): credentials
 * stay encrypted and out of every view, syncs run through the lead import,
 * failures land in lastError. Adapters and the database are mocked.
 */
import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { prisma } from "../prisma";
import { isolatePrisma } from "../test-helpers/prisma";
import { decryptField, encryptField } from "../encryption";
import { zenoti } from "./zenoti";
import { CrmError } from "./types";
import { connectIntegration, disconnectIntegration, integrationViews, syncIntegration, type Actor } from "./integrations";

process.env.FIELD_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
delete process.env.MINDBODY_API_KEY;

const KEY = "zk_test_secret_value";
const staff: Actor = { via: "staff", actorId: "agent-1", actorRole: "CALL_AGENT", linkId: null };
const link: Actor = { via: "clinic_link", actorId: null, actorRole: "CLINIC_LINK", linkId: "link-1" };
const UPDATED = new Date("2026-11-13T18:00:00Z");

let restore: () => void;
let audits: { action: string; metadata: string | null }[];
let upserts: { create: Record<string, unknown>; update: Record<string, unknown> }[];
let integrationUpdates: Record<string, unknown>[];
let importUpdates: Record<string, unknown>[];
let created: Record<string, unknown>[];

function row(over: Record<string, unknown> = {}) {
  return {
    id: "int-1",
    provider: "zenoti",
    status: "connected",
    credentials: encryptField(JSON.stringify({ apiKey: KEY, centerId: "c1" })),
    accountLabel: "Downtown Med Spa",
    connectedVia: "staff",
    lastSyncAt: null,
    lastError: null,
    updatedAt: UPDATED,
    ...over,
  };
}

beforeEach(() => {
  restore = isolatePrisma();
  audits = [];
  upserts = [];
  integrationUpdates = [];
  importUpdates = [];
  created = [];
  mock.method(prisma.auditLog, "create", async (args: { data: { action: string; metadata: string | null } }) => {
    audits.push(args.data);
    return {};
  });
  mock.method(prisma.clinicIntegration, "upsert", async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
    upserts.push(args);
    return row({ ...args.update, id: "int-1" });
  });
  mock.method(prisma.clinicIntegration, "update", async (args: { data: Record<string, unknown> }) => {
    integrationUpdates.push(args.data);
    return row(args.data);
  });
  // The lead import the sync feeds.
  mock.method(prisma.callRules, "findUnique", async () => null);
  mock.method(prisma.clinic, "findUnique", async () => ({ state: "TX" }));
  mock.method(prisma.lead, "findMany", async () => []);
  mock.method(prisma, "$queryRaw", async () => []);
  Reflect.set(prisma.lead, "createManyAndReturn", async (args: { data: Record<string, unknown>[] }) => {
    created.push(...args.data);
    return args.data.map((d) => ({ id: `lead-${d.phone}`, phone: d.phone }));
  });
  mock.method(prisma.leadActivity, "createMany", async () => ({ count: 0 }));
  mock.method(prisma.leadImport, "create", async () => ({ id: "imp-1", createdAt: UPDATED, rowsTotal: 0, status: "running" }));
  mock.method(prisma.leadImport, "update", async (args: { data: Record<string, unknown> }) => {
    importUpdates.push(args.data);
    return { rowsTotal: 2, created: 2, updated: 0, skipped: 0, invalid: 0 };
  });
});
afterEach(() => {
  mock.restoreAll();
  restore();
});

test("views list every connector and never carry credentials", async () => {
  mock.method(prisma.clinicIntegration, "findMany", async () => [row()]);
  const views = await integrationViews("clinic-1");
  assert.deepEqual(views.map((v) => [v.provider, v.status]), [
    ["zenoti", "connected"],
    ["mindbody", "not_connected"],
    ["aesthetic_record", "not_connected"],
  ]);
  assert.doesNotMatch(JSON.stringify(views), /zk_test|credentials|enc:v1/);
  assert.match(views[1].unavailable ?? "", /isn't available yet/, "no MINDBODY_API_KEY yet");
});

test("connecting stores the key encrypted, audits without it, and returns a safe view", async () => {
  mock.method(prisma.clinicIntegration, "findUnique", async () => null);
  mock.method(zenoti, "connect", async () => ({
    status: "connected" as const,
    credentials: { apiKey: KEY, centerId: "c1" },
    accountLabel: "Downtown Med Spa",
    externalId: "c1",
  }));
  const { view, step } = await connectIntegration({ clinicId: "clinic-1", provider: "zenoti", input: { apiKey: KEY }, actor: link });
  assert.equal(step, null);
  assert.equal(view.status, "connected");
  assert.doesNotMatch(JSON.stringify(view), /zk_test/);
  const stored = upserts[0].create.credentials as string;
  assert.match(stored, /^enc:v1:/);
  assert.deepEqual(JSON.parse(decryptField(stored)!), { apiKey: KEY, centerId: "c1" });
  assert.equal(upserts[0].create.connectedVia, "clinic_link");
  assert.equal(audits[0].action, "crm.connect");
  assert.doesNotMatch(String(audits[0].metadata), /zk_test/);
  assert.deepEqual(JSON.parse(String(audits[0].metadata)), { provider: "zenoti", status: "connected", via: "clinic_link", linkId: "link-1" });
});

test("a pending step gets the decrypted credentials from the step before", async () => {
  mock.method(prisma.clinicIntegration, "findUnique", async () =>
    row({ status: "pending", credentials: encryptField(JSON.stringify({ apiKey: KEY })) }),
  );
  const connect = mock.method(zenoti, "connect", async () => ({
    status: "connected" as const,
    credentials: { apiKey: KEY, centerId: "c2" },
    accountLabel: "Uptown",
    externalId: "c2",
  }));
  await connectIntegration({ clinicId: "clinic-1", provider: "zenoti", input: { centerId: "c2" }, actor: staff });
  assert.deepEqual(connect.mock.calls[0].arguments, [{ centerId: "c2" }, { apiKey: KEY }]);
});

test("in production, keys are never stored without the encryption key", async () => {
  const env = process.env as Record<string, string | undefined>;
  const prevEnv = env.NODE_ENV;
  const prevKey = env.FIELD_ENCRYPTION_KEY;
  env.NODE_ENV = "production";
  delete env.FIELD_ENCRYPTION_KEY;
  try {
    mock.method(prisma.clinicIntegration, "findUnique", async () => null);
    mock.method(zenoti, "connect", async () => ({ status: "connected" as const, credentials: { apiKey: KEY }, accountLabel: "x", externalId: null }));
    await assert.rejects(connectIntegration({ clinicId: "clinic-1", provider: "zenoti", input: { apiKey: KEY }, actor: staff }), { kind: "unavailable" });
    assert.equal(upserts.length, 0);
  } finally {
    env.NODE_ENV = prevEnv;
    env.FIELD_ENCRYPTION_KEY = prevKey;
  }
});

test("Mindbody can't be connected until RevOS has its developer key", async () => {
  await assert.rejects(connectIntegration({ clinicId: "clinic-1", provider: "mindbody", input: { siteId: "1" }, actor: staff }), {
    kind: "unavailable",
  });
});

test("disconnecting forgets the credentials", async () => {
  mock.method(prisma.clinicIntegration, "findUnique", async () => row());
  const view = await disconnectIntegration({ clinicId: "clinic-1", provider: "zenoti", actor: staff });
  assert.deepEqual(integrationUpdates[0], { status: "disconnected", credentials: null, lastError: null });
  assert.equal(view?.status, "disconnected");
  assert.equal(audits[0].action, "crm.disconnect");
});

test("sync: a LeadImport from the CRM, leads changed since the last sync (a day of overlap), then lastSyncAt", async () => {
  const last = new Date("2026-11-10T15:00:00Z");
  mock.method(prisma.clinicIntegration, "findUnique", async () => row({ lastSyncAt: last }));
  const fetch = mock.method(zenoti, "fetchLeads", async () => ({
    records: [
      { externalId: "g1", firstName: "Test", lastName: "One", phones: ["(555) 010-0301"] },
      { externalId: "g2", fullName: "Test Two", phones: [null, "5550100302"], source: "Instagram" },
      { externalId: "g3", phones: ["no phone"] },
    ],
    startIndex: 0,
    nextCursor: null,
  }));
  const res = await syncIntegration({ clinicId: "clinic-1", provider: "zenoti", actor: staff });
  assert.equal(res.done, true);
  assert.equal(res.cursor, null);
  assert.deepEqual([res.counts.received, res.counts.created, res.counts.invalid], [3, 2, 1]);
  const opts = fetch.mock.calls[0].arguments[1] as { since: Date; limit: number };
  assert.deepEqual(opts.since, new Date(last.getTime() - 86_400_000));
  assert.equal(opts.limit, 500);
  assert.deepEqual(fetch.mock.calls[0].arguments[0], { apiKey: KEY, centerId: "c1" }, "decrypted for the adapter only");
  assert.deepEqual(created.map((c) => [c.phone, c.source, c.externalId]), [
    ["5550100301", "zenoti", "g1"],
    ["5550100302", "zenoti", "g2"],
  ]);
  assert.equal(importUpdates.at(-1)?.status, "done");
  assert.deepEqual(integrationUpdates.at(-1), { lastSyncAt: UPDATED, lastError: null });
  assert.deepEqual(audits.map((a) => a.action), ["lead_import.start", "lead_import.finish"]);
});

test("sync: more to come hands back the cursor and keeps lastSyncAt", async () => {
  mock.method(prisma.clinicIntegration, "findUnique", async () => row());
  mock.method(prisma.leadImport, "findFirst", async () => ({ id: "imp-1", createdAt: UPDATED, rowsTotal: 500, status: "running" }));
  mock.method(zenoti, "fetchLeads", async () => ({ records: [{ phones: ["5550100303"] }], startIndex: 500, nextCursor: "next" }));
  const res = await syncIntegration({ clinicId: "clinic-1", provider: "zenoti", importId: "imp-1", cursor: "c", actor: staff });
  assert.deepEqual([res.done, res.cursor], [false, "next"]);
  assert.equal(integrationUpdates.length, 0);
  assert.deepEqual(created[0].createdAt, new Date(UPDATED.getTime() + 500), "CRM order kept across batches");
});

test("sync failures are stored as short messages; a rejected key marks the connection for attention", async () => {
  mock.method(prisma.clinicIntegration, "findUnique", async () => row());
  mock.method(zenoti, "fetchLeads", async () => {
    throw new CrmError("Zenoti didn't accept this API key.", "auth");
  });
  await assert.rejects(syncIntegration({ clinicId: "clinic-1", provider: "zenoti", actor: staff }), { kind: "auth" });
  assert.deepEqual(importUpdates.at(-1), { status: "failed", error: "Zenoti didn't accept this API key." });
  assert.deepEqual(integrationUpdates.at(-1), { lastError: "Zenoti didn't accept this API key.", status: "error" });

  mock.method(zenoti, "fetchLeads", async () => {
    throw new Error(`socket hang up with ${KEY}`);
  });
  mock.method(console, "error", () => {});
  await assert.rejects(syncIntegration({ clinicId: "clinic-1", provider: "zenoti", actor: staff }), { kind: "upstream" });
  assert.equal(integrationUpdates.at(-1)?.lastError, "The sync stopped partway. Try again.", "raw errors never reach lastError");
});

test("sync needs a connected account", async () => {
  mock.method(prisma.clinicIntegration, "findUnique", async () => row({ status: "pending" }));
  await assert.rejects(syncIntegration({ clinicId: "clinic-1", provider: "zenoti", actor: staff }), { kind: "input" });
});
