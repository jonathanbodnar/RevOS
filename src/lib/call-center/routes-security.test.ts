import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { NextRequest } from "next/server";
import { prisma } from "../prisma";
import { isolatePrisma } from "../test-helpers/prisma";
import { GET as deskGET } from "../../app/api/call-center/[clinicId]/desk/route";
import { GET as leadsGET, POST as leadsPOST } from "../../app/api/call-center/[clinicId]/leads/route";
import { GET as leadGET } from "../../app/api/call-center/[clinicId]/leads/[leadId]/route";
import { POST as outcomePOST } from "../../app/api/call-center/[clinicId]/leads/[leadId]/outcome/route";
import { POST as updatePOST } from "../../app/api/call-center/[clinicId]/leads/[leadId]/update/route";
import { POST as skipPOST } from "../../app/api/call-center/[clinicId]/leads/[leadId]/skip/route";
import { POST as morePOST } from "../../app/api/call-center/[clinicId]/more/route";
import { GET as rulesGET, PUT as rulesPUT } from "../../app/api/call-center/[clinicId]/rules/route";
import { GET as reportGET } from "../../app/api/call-center/[clinicId]/report/route";
import { GET as dialerGET, POST as dialerPOST } from "../../app/api/call-center/[clinicId]/dialer/route";
import { POST as tokenPOST } from "../../app/api/call-center/phone/token/route";
import { GET as telnyxGET, POST as telnyxPOST } from "../../app/api/call-center/admin/telnyx/route";
import { GET as numbersGET, POST as numbersPOST } from "../../app/api/call-center/admin/numbers/route";
import { DELETE as numberDELETE } from "../../app/api/call-center/admin/numbers/[id]/route";
import { PUT as accessPUT } from "../../app/api/admin/users/[id]/call-center/route";
import { POST as webhookPOST } from "../../app/api/webhooks/telnyx/route";

const nextAuth = createRequire(import.meta.url)("next-auth/next");
const req = (body?: unknown, url = "http://localhost/api/test") =>
  new NextRequest(url, body === undefined ? { method: "GET" } : { method: "POST", body: JSON.stringify(body) });
const ctx = (p: Record<string, unknown>) => ({ params: Promise.resolve(p) }) as never;

type Route = (r: NextRequest, c: never) => Promise<Response>;
const clinicRoutes: [string, Route, Record<string, unknown>][] = [
  ["desk", deskGET as Route, { clinicId: "clinic-a" }],
  ["leads GET", leadsGET as Route, { clinicId: "clinic-a" }],
  ["leads POST", leadsPOST as Route, { clinicId: "clinic-a" }],
  ["lead GET", leadGET as Route, { clinicId: "clinic-a", leadId: "lead-1" }],
  ["outcome", outcomePOST as Route, { clinicId: "clinic-a", leadId: "lead-1" }],
  ["update", updatePOST as Route, { clinicId: "clinic-a", leadId: "lead-1" }],
  ["skip", skipPOST as Route, { clinicId: "clinic-a", leadId: "lead-1" }],
  ["more", morePOST as Route, { clinicId: "clinic-a" }],
  ["rules GET", rulesGET as Route, { clinicId: "clinic-a" }],
  ["rules PUT", rulesPUT as Route, { clinicId: "clinic-a" }],
  ["report", reportGET as Route, { clinicId: "clinic-a" }],
  ["dialer GET", dialerGET as Route, { clinicId: "clinic-a" }],
  ["dialer POST", dialerPOST as Route, { clinicId: "clinic-a" }],
];

let restorePrisma: () => void;
beforeEach(() => {
  restorePrisma = isolatePrisma();
  mock.method(prisma.auditLog, "create", async () => ({}));
  mock.method(prisma.clinic, "findUnique", async () => ({ id: "clinic-a", isActive: true }));
  mock.method(prisma.callCenterAccess, "findUnique", async () => null);
});
afterEach(() => {
  mock.restoreAll();
  restorePrisma();
});

test("clinic call-center routes: signed out 401, clinic admin 403, agent without that clinic 404", async () => {
  const cases: [unknown, number][] = [
    [null, 401],
    [{ user: { id: "u1", originalRole: "CLINIC_ADMIN" } }, 403],
    [{ user: { id: "u1", originalRole: "PROVIDER" } }, 403],
    [{ user: { id: "u1", originalRole: "BILLING_DEPT" } }, 403],
    [{ user: { id: "agent", originalRole: "CALL_AGENT" } }, 404],
  ];
  for (const [session, status] of cases) {
    mock.method(nextAuth, "getServerSession", async () => session);
    for (const [name, route, p] of clinicRoutes) {
      const res = await route(req(name.includes("GET") || name === "desk" || name === "report" ? undefined : {}), ctx(p));
      assert.equal(res.status, status, `${name} for ${JSON.stringify(session)}`);
    }
  }
});

test("a clinic that's inactive or missing is a 404 even for super admins", async () => {
  mock.method(nextAuth, "getServerSession", async () => ({ user: { id: "admin", originalRole: "SUPER_ADMIN" } }));
  mock.method(prisma.clinic, "findUnique", async () => ({ id: "clinic-a", isActive: false }));
  for (const [name, route, p] of clinicRoutes) {
    const res = await route(req(name.includes("GET") ? undefined : {}), ctx(p));
    assert.equal(res.status, 404, name);
  }
});

test("path params that aren't strings never reach the database", async () => {
  mock.method(nextAuth, "getServerSession", async () => ({ user: { id: "admin", originalRole: "SUPER_ADMIN" } }));
  for (const bad of [{ not: "" }, ["x"], null, 123, ""]) {
    for (const [name, route, p] of clinicRoutes) {
      const params = Object.fromEntries(Object.keys(p).map((k) => [k, bad]));
      const res = await route(req({}), ctx(params));
      assert.equal(res.status, 400, name);
    }
  }
});

test("phone setup, numbers and agent clinic lists are super admin only", async () => {
  for (const session of [null, { user: { id: "agent", originalRole: "CALL_AGENT" } }, { user: { id: "ca", originalRole: "CLINIC_ADMIN" } }]) {
    mock.method(nextAuth, "getServerSession", async () => session);
    for (const res of [
      await telnyxGET(),
      await telnyxPOST(req({})),
      await numbersGET(req(undefined, "http://localhost/api/x?areaCode=817")),
      await numbersPOST(req({ clinicId: "clinic-a0000", phoneNumber: "5550100000", mode: "buy" })),
      await numberDELETE(req(undefined), ctx({ id: "num1" })),
      await accessPUT(req({ clinicIds: [] }), ctx({ id: "user1" })),
    ]) {
      assert.ok([401, 403].includes(res.status), `got ${res.status}`);
    }
  }
});

test("browser-phone tokens only for the call center", async () => {
  for (const [session, status] of [
    [null, 401],
    [{ user: { id: "ca", originalRole: "CLINIC_ADMIN" } }, 403],
  ] as const) {
    mock.method(nextAuth, "getServerSession", async () => session);
    assert.equal((await tokenPOST()).status, status);
  }
});

test("Telnyx webhooks fail closed without a key and reject bad signatures", async () => {
  const prev = process.env.TELNYX_PUBLIC_KEY;
  delete process.env.TELNYX_PUBLIC_KEY;
  assert.equal((await webhookPOST(new Request("http://localhost/api/webhooks/telnyx", { method: "POST", body: "{}" }))).status, 503);
  process.env.TELNYX_PUBLIC_KEY = Buffer.alloc(32, 7).toString("base64");
  const res = await webhookPOST(
    new Request("http://localhost/api/webhooks/telnyx", {
      method: "POST",
      body: JSON.stringify({ data: { event_type: "call.hangup", payload: {} } }),
      headers: { "telnyx-signature-ed25519": Buffer.alloc(64).toString("base64"), "telnyx-timestamp": String(Math.floor(Date.now() / 1000)) },
    }),
  );
  assert.equal(res.status, 401);
  if (prev === undefined) delete process.env.TELNYX_PUBLIC_KEY;
  else process.env.TELNYX_PUBLIC_KEY = prev;
});
