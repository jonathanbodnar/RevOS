import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { createRequire } from "node:module";
import { NextRequest } from "next/server";
import { prisma } from "./prisma";
import { isolatePrisma } from "./test-helpers/prisma";
import { encryptField } from "./encryption";
import { toNoteViews } from "./customer-notes";
import { POST as addNote } from "../app/api/clinic/customers/[id]/notes/route";
import { DELETE as removeNote } from "../app/api/clinic/customers/[id]/notes/[noteId]/route";
import { POST as mergeCustomer } from "../app/api/clinic/customers/[id]/merge/route";

// Real route handlers with the session provider and database mocked, as in
// security-routes.test.ts — isolatePrisma fails any query a test didn't expect.
const nextAuth = createRequire(import.meta.url)("next-auth/next");
const KEY = crypto.randomBytes(32).toString("hex");

const clinicAdmin = { user: { id: "admin-1", originalRole: "CLINIC_ADMIN", effectiveClinicId: "clinic-1" } };
const provider = { user: { id: "prov-1", originalRole: "PROVIDER", effectiveClinicId: "clinic-1" } };
const superAdmin = { user: { id: "super-1", originalRole: "SUPER_ADMIN", effectiveClinicId: "clinic-1" } };

const post = (body: unknown) =>
  new NextRequest("http://localhost/api/test", { method: "POST", body: JSON.stringify(body) });
const del = () => new NextRequest("http://localhost/api/test", { method: "DELETE" });
const addCtx = (id: unknown) => ({ params: Promise.resolve({ id }) }) as Parameters<typeof addNote>[1];
const removeCtx = (id: unknown, noteId: unknown) =>
  ({ params: Promise.resolve({ id, noteId }) }) as Parameters<typeof removeNote>[1];
const signIn = (session: unknown) => mock.method(nextAuth, "getServerSession", async () => session);

let restorePrisma: () => void;
let audits: { action: string; metadata: string | null }[];
beforeEach(() => {
  restorePrisma = isolatePrisma();
  process.env.FIELD_ENCRYPTION_KEY = KEY;
  audits = [];
  mock.method(prisma.auditLog, "create", async (args: { data: { action: string; metadata: string | null } }) => {
    audits.push(args.data);
    return {};
  });
});
afterEach(() => {
  mock.restoreAll();
  restorePrisma();
  delete process.env.FIELD_ENCRYPTION_KEY;
});

test("notes routes turn away signed-out users and query-object params before any database access", async () => {
  signIn(null);
  assert.equal((await addNote(post({ body: "x" }), addCtx("c")))?.status, 401);
  assert.equal((await removeNote(del(), removeCtx("c", "n")))?.status, 401);

  mock.restoreAll();
  mock.method(prisma.auditLog, "create", async () => ({}));
  signIn(clinicAdmin);
  for (const bad of [{ not: "" }, ["c"], null, 123, ""]) {
    assert.equal((await addNote(post({ body: "x" }), addCtx(bad)))?.status, 400);
    assert.equal((await removeNote(del(), removeCtx(bad, "n")))?.status, 400);
    assert.equal((await removeNote(del(), removeCtx("c", bad)))?.status, 400);
  }
});

test("a note needs text, within the length limit", async () => {
  signIn(clinicAdmin);
  for (const body of ["", "  \n\t ", "x".repeat(5001), { not: "" }, 42, undefined]) {
    assert.equal((await addNote(post({ body }), addCtx("c")))?.status, 400, JSON.stringify(body));
  }
});

test("providers can only write on their assigned patients", async () => {
  signIn(provider);
  const lookup = mock.method(prisma.customer, "findFirst", async () => null);
  const res = await addNote(post({ body: "Checked in." }), addCtx("someone-else"));
  assert.equal(res?.status, 404);
  assert.deepEqual(lookup.mock.calls[0].arguments[0]?.where, {
    id: "someone-else",
    clinicId: "clinic-1",
    providerAssignments: { some: { providerId: "prov-1" } },
  });
});

test("a note is stored encrypted, comes back dated and readable, and its text stays out of the audit log", async () => {
  signIn(clinicAdmin);
  mock.method(prisma.customer, "findFirst", async () => ({ id: "cust-1" }));
  const create = mock.method(prisma.customerNote, "create", async (args: { data: Record<string, unknown> }) => ({
    id: "note-1",
    ...args.data,
    createdAt: new Date("2026-10-12T15:04:00Z"),
    deletedAt: null,
    deletedById: null,
  }));
  mock.method(prisma.user, "findMany", async () => [{ id: "admin-1", name: "Dana Reyes", email: "dana@clinic.test" }]);

  const res = await addNote(post({ body: "  Called to confirm Thursday.\nAll good.  " }), addCtx("cust-1"));
  assert.equal(res?.status, 201);

  const stored = create.mock.calls[0].arguments[0].data;
  assert.equal(stored.customerId, "cust-1");
  assert.equal(stored.clinicId, "clinic-1");
  assert.equal(stored.authorId, "admin-1");
  assert.match(String(stored.body), /^enc:v1:/);
  assert.ok(!String(stored.body).includes("Thursday"));

  assert.deepEqual((await res.json()).data, {
    id: "note-1",
    body: "Called to confirm Thursday.\nAll good.",
    authorName: "Dana Reyes",
    createdAt: "2026-10-12T15:04:00.000Z",
    canRemove: true,
  });
  assert.deepEqual(audits.map((a) => a.action), ["customer_note.create"]);
  assert.ok(!JSON.stringify(audits).includes("Thursday"));
});

test("only the note's author or a super admin can remove it, and removal keeps the row", async () => {
  mock.method(prisma.customer, "findFirst", async () => ({ id: "cust-1" }));
  mock.method(prisma.customerNote, "findFirst", async () => ({ id: "note-1", authorId: "prov-1" }));
  const update = mock.method(prisma.customerNote, "update", async () => ({}));

  const nextAuthMock = signIn(clinicAdmin);
  assert.equal((await removeNote(del(), removeCtx("cust-1", "note-1")))?.status, 403);
  assert.equal(update.mock.callCount(), 0);

  nextAuthMock.mock.mockImplementation(async () => provider);
  assert.equal((await removeNote(del(), removeCtx("cust-1", "note-1")))?.status, 200);
  const args = update.mock.calls[0].arguments[0] as { where: unknown; data: { deletedAt: unknown; deletedById: unknown } };
  assert.deepEqual(args.where, { id: "note-1" });
  assert.equal(args.data.deletedById, "prov-1");
  assert.ok(args.data.deletedAt instanceof Date);

  nextAuthMock.mock.mockImplementation(async () => superAdmin);
  assert.equal((await removeNote(del(), removeCtx("cust-1", "note-1")))?.status, 200);
  assert.deepEqual(audits.map((a) => a.action), ["customer_note.delete", "customer_note.delete"]);
});

test("a note that's already removed, or on another patient, can't be removed", async () => {
  signIn(clinicAdmin);
  mock.method(prisma.customer, "findFirst", async () => ({ id: "cust-1" }));
  const lookup = mock.method(prisma.customerNote, "findFirst", async () => null);
  assert.equal((await removeNote(del(), removeCtx("cust-1", "note-9")))?.status, 404);
  assert.deepEqual(lookup.mock.calls[0].arguments[0]?.where, { id: "note-9", customerId: "cust-1", deletedAt: null });
});

test("the feed survives a note it can't decrypt and an author it can't find", async () => {
  process.env.FIELD_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
  const underLostKey = encryptField("written under a key that's gone") as string;
  process.env.FIELD_ENCRYPTION_KEY = KEY;
  mock.method(prisma.user, "findMany", async () => []);

  const note = { id: "n", body: underLostKey, authorId: "gone", createdAt: new Date("2026-10-01T00:00:00Z") };
  const [asAdmin] = await toNoteViews([note], clinicAdmin.user);
  assert.deepEqual(asAdmin, {
    id: "n",
    body: null,
    authorName: "Unknown user",
    createdAt: "2026-10-01T00:00:00.000Z",
    canRemove: false,
  });
  const [asSuper] = await toNoteViews([note], superAdmin.user);
  assert.equal(asSuper.canRemove, true);
});

test("merging a duplicate profile moves its notes onto the profile that's kept, before deleting it", async () => {
  signIn(superAdmin);
  mock.method(prisma.customer, "findFirst", async (args: { where: { id: string } }) => ({
    id: args.where.id,
    paymentNotes: null,
    implementorId: null,
    email: null,
    phone: null,
    firstName: "Maria",
    lastName: "Lopez",
  }));
  mock.method(prisma.paymentMethod, "count", async () => 0);
  const calls: string[] = [];
  let notesMove: unknown;
  // Records every delegate call made inside the merge transaction.
  const tx = new Proxy({}, {
    get: (_t, model: string) =>
      new Proxy({}, {
        get: (_m, op: string) => async (args: unknown) => {
          calls.push(`${model}.${op}`);
          if (model === "customerNote") notesMove = args;
          return {};
        },
      }),
  });
  mock.method(prisma, "$transaction", async (callback: (client: unknown) => unknown) => callback(tx));

  const res = await mergeCustomer(post({ sourceCustomerId: "duplicate" }), addCtx("kept"));
  assert.equal(res?.status, 200);
  assert.deepEqual(notesMove, { where: { customerId: "duplicate" }, data: { customerId: "kept" } });
  assert.ok(calls.indexOf("customerNote.updateMany") < calls.indexOf("customer.delete"));
});
