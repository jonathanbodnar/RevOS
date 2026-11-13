/**
 * Guards on the import, CRM and connect-link routes. Executes the real route
 * handlers with next-auth's session and the database mocked (the same
 * approach as src/lib/security-routes.test.ts).
 */
import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { prisma } from "../prisma";
import { isolatePrisma } from "../test-helpers/prisma";
import { EXPIRED_MESSAGE, newConnectToken, resetRateLimits } from "./connect-link";
import { GET as importsGet, POST as importsPost } from "../../app/api/call-center/[clinicId]/imports/route";
import { GET as integrationsGet } from "../../app/api/call-center/[clinicId]/integrations/route";
import {
  DELETE as integrationDelete,
  POST as integrationPost,
} from "../../app/api/call-center/[clinicId]/integrations/[provider]/route";
import { POST as syncPost } from "../../app/api/call-center/[clinicId]/integrations/[provider]/sync/route";
import { GET as linksGet, POST as linksPost } from "../../app/api/call-center/[clinicId]/connect-links/route";
import { DELETE as linkDelete } from "../../app/api/call-center/[clinicId]/connect-links/[linkId]/route";
import { POST as publicImport } from "../../app/api/public/connect/[token]/imports/route";
import { POST as publicConnect } from "../../app/api/public/connect/[token]/integrations/[provider]/route";
import { POST as publicSync } from "../../app/api/public/connect/[token]/integrations/[provider]/sync/route";

const nextAuth = createRequire(import.meta.url)("next-auth/next");

type Handler = (req: Request, ctx: never) => Promise<Response>;
const req = (method: string, body?: unknown) =>
  new Request("http://localhost/api/test", {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.20" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ctx = (params: Record<string, unknown>) => ({ params: Promise.resolve(params) }) as never;

const STAFF: [string, Handler, string, Record<string, unknown>][] = [
  ["GET imports", importsGet as Handler, "GET", {}],
  ["POST imports", importsPost as Handler, "POST", {}],
  ["GET integrations", integrationsGet as Handler, "GET", {}],
  ["POST integration", integrationPost as Handler, "POST", { provider: "zenoti" }],
  ["DELETE integration", integrationDelete as Handler, "DELETE", { provider: "zenoti" }],
  ["POST sync", syncPost as Handler, "POST", { provider: "zenoti" }],
  ["GET links", linksGet as Handler, "GET", {}],
  ["POST links", linksPost as Handler, "POST", {}],
  ["DELETE link", linkDelete as Handler, "DELETE", { linkId: "link-1" }],
];

const PUBLIC: [string, Handler, Record<string, unknown>][] = [
  ["public import", publicImport as Handler, {}],
  ["public connect", publicConnect as Handler, { provider: "zenoti" }],
  ["public sync", publicSync as Handler, { provider: "zenoti" }],
];

let restore: () => void;
beforeEach(() => {
  restore = isolatePrisma();
  resetRateLimits();
  mock.method(prisma.auditLog, "create", async () => ({}));
});
afterEach(() => {
  mock.restoreAll();
  restore();
});

function session(role: string | null, id = "user-1") {
  mock.method(nextAuth, "getServerSession", async () =>
    role ? { user: { id, email: "x@example.test", originalRole: role, role, effectiveClinicId: null, clinicId: null } } : null,
  );
}

test("staff routes: 401 signed out, 403 for roles without the call center", async () => {
  for (const [role, status] of [[null, 401], ["CLINIC_ADMIN", 403], ["PROVIDER", 403], ["BILLING_DEPT", 403]] as const) {
    session(role);
    for (const [name, handler, method, params] of STAFF) {
      const res = await handler(req(method, method === "GET" || method === "DELETE" ? undefined : {}), ctx({ clinicId: "clinic-1", ...params }));
      assert.equal(res.status, status, `${name} as ${role}`);
    }
  }
});

test("staff routes: 404 for a call agent without access to the clinic (ids don't leak)", async () => {
  session("CALL_AGENT", "agent-1");
  mock.method(prisma.clinic, "findUnique", async () => ({ id: "clinic-1", isActive: true }));
  const access = mock.method(prisma.callCenterAccess, "findUnique", async () => null);
  for (const [name, handler, method, params] of STAFF) {
    const res = await handler(req(method, method === "GET" || method === "DELETE" ? undefined : {}), ctx({ clinicId: "clinic-1", ...params }));
    assert.equal(res.status, 404, name);
  }
  assert.deepEqual(access.mock.calls[0].arguments[0]?.where, { userId_clinicId: { userId: "agent-1", clinicId: "clinic-1" } });
});

test("staff routes: query objects in path params are refused before any database call", async () => {
  session("SUPER_ADMIN");
  for (const bad of [{ not: "" }, ["clinic-1"], "", null, 7]) {
    for (const [name, handler, method, params] of STAFF) {
      const res = await handler(req(method), ctx({ clinicId: bad, ...params }));
      assert.equal(res.status, 400, `${name} with ${JSON.stringify(bad)}`);
    }
  }
});

test("a call agent with access gets through; unknown CRMs are 404", async () => {
  session("CALL_AGENT", "agent-1");
  mock.method(prisma.clinic, "findUnique", async () => ({ id: "clinic-1", isActive: true }));
  mock.method(prisma.callCenterAccess, "findUnique", async () => ({ clinicId: "clinic-1" }));
  mock.method(prisma.leadImport, "findMany", async () => []);
  const ok = await importsGet(req("GET"), ctx({ clinicId: "clinic-1" }));
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { imports: [] });
  const unknown = await integrationPost(req("POST", { input: {} }), ctx({ clinicId: "clinic-1", provider: "salesforce" }));
  assert.equal(unknown.status, 404);
  const badBody = await importsPost(req("POST", { rows: "all of them" }), ctx({ clinicId: "clinic-1" }));
  assert.equal(badBody.status, 400);
});

test("public routes: made-up, revoked and expired tokens all get the expired message", async () => {
  session(null);
  const lookups = mock.method(prisma.clinicConnectLink, "findUnique", async () => null);
  for (const [name, handler, params] of PUBLIC) {
    const res = await handler(req("POST", {}), ctx({ token: "not-a-real-token", ...params }));
    assert.equal(res.status, 404, name);
    assert.deepEqual(await res.json(), { error: EXPIRED_MESSAGE });
  }
  assert.equal(lookups.mock.callCount(), 0, "malformed tokens never reach the database");

  const token = newConnectToken();
  const clinic = { id: "clinic-1", name: "Downtown Med Spa", logoUrl: null, isActive: true };
  for (const link of [
    { id: "l1", clinicId: "clinic-1", expiresAt: null, revokedAt: new Date("2026-11-01"), clinic },
    { id: "l2", clinicId: "clinic-1", expiresAt: new Date("2026-01-01"), revokedAt: null, clinic },
  ]) {
    mock.method(prisma.clinicConnectLink, "findUnique", async () => link);
    for (const [name, handler, params] of PUBLIC) {
      const res = await handler(req("POST", {}), ctx({ token, ...params }));
      assert.equal(res.status, 404, `${name} ${link.id}`);
    }
  }
  for (const [name, handler, params] of PUBLIC) {
    const res = await handler(req("POST", {}), ctx({ token: { $ne: "" }, ...params }));
    assert.equal(res.status, 400, `${name} with an object token`);
  }
});

test("public upload answers with what was sent, never what RevOS already had", async () => {
  session(null);
  const token = newConnectToken();
  mock.method(prisma.clinicConnectLink, "findUnique", async () => ({
    id: "link-1",
    clinicId: "clinic-1",
    expiresAt: null,
    revokedAt: null,
    clinic: { id: "clinic-1", name: "Downtown Med Spa", logoUrl: null, isActive: true },
  }));
  mock.method(prisma.clinicConnectLink, "update", async () => ({}));
  mock.method(prisma.leadImport, "create", async () => ({ id: "imp-1", source: "csv", fileName: "x.csv", createdAt: new Date(), rowsTotal: 0, status: "running" }));
  mock.method(prisma.leadImport, "update", async () => ({ rowsTotal: 1, created: 0, updated: 1, skipped: 0, invalid: 0 }));
  mock.method(prisma.callRules, "findUnique", async () => null);
  mock.method(prisma.clinic, "findUnique", async () => ({ state: "TX" }));
  // The phone belongs to an existing lead who is also a patient.
  mock.method(prisma.lead, "findMany", async () => [
    { id: "L1", phone: "5550100401", firstName: null, lastName: null, email: null, externalId: null, priority: false, stage: "new", lastNote: null, customerId: null, consentAt: null, activities: [] },
  ]);
  mock.method(prisma, "$queryRaw", async () => [{ id: "cust-1", phone: "5550100401" }]);
  mock.method(prisma.lead, "update", async () => ({}));
  mock.method(prisma.leadActivity, "createMany", async () => ({ count: 1 }));

  const res = await publicImport(
    req("POST", {
      source: "csv",
      fileName: "x.csv",
      options: { consentAll: false, updateStatuses: true, priorityMapped: false },
      rows: [{ index: 0, phone: "5550100401", firstName: "Test" }],
      done: true,
      fileStats: { invalid: 0, duplicates: 0 },
    }),
    ctx({ token }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { importId: "imp-1", done: true, counts: { received: 1, invalid: 0 } });
});
