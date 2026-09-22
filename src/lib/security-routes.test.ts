import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { NextRequest } from "next/server";
import { prisma } from "./prisma";
import { lunarpay, LunarPayError } from "./lunarpay";
import { isolatePrisma } from "./test-helpers/prisma";
import { POST as followUp } from "../app/api/admin/charges/[id]/follow-up/route";
import { POST as moveClinic } from "../app/api/admin/customers/[id]/move-clinic/route";
import { POST as assignDevice } from "../app/api/admin/inbody/devices/[id]/route";
import { POST as restart } from "../app/api/admin/subscriptions/[id]/restart/route";

// Mock the session provider and database boundary, so these tests execute the
// real route handlers/guards without opening a DB connection or billing anyone.
const nextAuth = createRequire(import.meta.url)("next-auth/next");
const admin = { user: { id: "admin", originalRole: "SUPER_ADMIN" } };
const context = (id: unknown) => ({ params: Promise.resolve({ id }) } as Parameters<typeof followUp>[1]);
const request = (body: unknown) => new NextRequest("http://localhost/api/test", { method: "POST", body: JSON.stringify(body) });

let restorePrisma: () => void;
beforeEach(() => {
  restorePrisma = isolatePrisma();
  mock.method(nextAuth, "getServerSession", async () => admin);
  mock.method(prisma.auditLog, "create", async () => ({}));
});
afterEach(() => { mock.restoreAll(); restorePrisma(); });

test("sensitive routes still deny unauthenticated users and clinic admins", async () => {
  for (const session of [null, { user: { originalRole: "CLINIC_ADMIN" } }]) {
    mock.method(nextAuth, "getServerSession", async () => session);
    for (const route of [followUp, moveClinic, assignDevice, restart]) {
      const result = await route(request({}), context("id"));
      assert.ok(result);
      assert.ok([401, 403].includes(result.status));
    }
  }
});

test("all affected routes reject query objects in path params before database access", async () => {
  for (const id of [{ not: "" }, { $ne: null }, ["id"], null, undefined, 123, ""]) {
    for (const route of [followUp, moveClinic, assignDevice, restart]) {
      const result = await route(request({}), context(id));
      assert.equal(result?.status, 400);
    }
  }
});

test("follow-up cascades only to the same patient's untouched failed charges", async () => {
  mock.method(prisma.charge, "findUnique", async () => ({ id: "charge-1", customerId: "customer-1", clinicId: "clinic-1", status: "failed", followUpStatus: "new" }));
  const update = mock.method(prisma.charge, "update", async () => ({}));
  const cascade = mock.method(prisma.charge, "updateMany", async () => ({ count: 2 }));
  const result = await followUp(request({ followUpStatus: "contacted", note: "Called", cascade: true }), context("charge-1"));
  assert.ok(result);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { ok: true, followUpStatus: "contacted", cascaded: 2 });
  assert.deepEqual(cascade.mock.calls[0].arguments[0]?.where, { customerId: { equals: "customer-1" }, status: "failed", followUpStatus: "new", id: { not: "charge-1" } });
  assert.equal(update.mock.calls[0].arguments[0]?.data.followUpNote, "Called");
});

test("moving a patient keeps all history together and clears old provider assignments", async () => {
  mock.method(prisma.customer, "findUnique", async () => ({ id: "customer-1", clinicId: "old-clinic" }));
  mock.method(prisma.clinic, "findUnique", async () => ({ id: "new-clinic", name: "Destination", isActive: true }));
  const updated: string[] = [];
  const tx = {
    customer: { update: async (args: unknown) => {
      assert.deepEqual(args, { where: { id: "customer-1" }, data: { clinicId: "new-clinic" } });
    } },
    customerProviderAssignment: { deleteMany: async (args: unknown) => {
      assert.deepEqual(args, { where: { customerId: { equals: "customer-1" } } });
      updated.push("assignments");
    } },
    ...Object.fromEntries(["charge", "subscription", "paymentSchedule", "checkoutSession", "careCredit", "advancedCost", "inBodyTest", "chartWeek", "kPIFlag"].map((model) => [model, { updateMany: async (args: unknown) => {
      assert.deepEqual(args, { where: { customerId: { equals: "customer-1" } }, data: { clinicId: "new-clinic" } });
      updated.push(model);
    } }])),
  };
  mock.method(prisma, "$transaction", async (callback: (client: unknown) => unknown) => callback(tx));
  const result = await moveClinic(request({ clinicId: "new-clinic" }), context("customer-1"));
  assert.equal(result.status, 200);
  assert.equal(updated.length, 10);
  assert.ok(updated.includes("paymentSchedule") && updated.includes("advancedCost") && updated.includes("assignments"));
});

test("body query objects cannot become clinic or payment-method filters", async () => {
  for (const clinicId of [{ not: "" }, ["clinic"], ""]) {
    assert.equal((await moveClinic(request({ clinicId }), context("customer"))).status, 400);
    assert.equal((await assignDevice(request({ clinicId }), context("device")))?.status, 400);
  }
  assert.equal((await restart(request({ paymentMethodId: { not: "" }, startOn: "2099-01-01" }), context("subscription")))?.status, 400);
});

test("device assignment fills only unattributed scans from that serial and can be cleared", async () => {
  mock.method(prisma.inBodyDevice, "findUnique", async () => ({ id: "device", serial: "SN-123" }));
  mock.method(prisma.clinic, "findUnique", async () => ({ id: "clinic" }));
  const update = mock.method(prisma.inBodyDevice, "update", async () => ({}));
  const scans = mock.method(prisma.inBodyTest, "updateMany", async () => ({ count: 3 }));
  const result = await assignDevice(request({ clinicId: "clinic", label: "Front", applyToExisting: true }), context("device"));
  assert.ok(result);
  assert.deepEqual(await result.json(), { ok: true, updatedScans: 3 });
  assert.deepEqual(scans.mock.calls[0].arguments[0], { where: { equipSerial: { equals: "SN-123" }, clinicId: null }, data: { clinicId: "clinic" } });
  const cleared = await assignDevice(request({ clinicId: null, applyToExisting: true }), context("device"));
  assert.equal(cleared?.status, 200);
  assert.equal(scans.mock.callCount(), 1);
  assert.deepEqual(update.mock.calls[1].arguments[0]?.data, { clinicId: null });
});

test("a failed subscription restart releases only that subscription's claim", async () => {
  mock.method(prisma.subscription, "findUnique", async () => ({ id: "subscription", status: "cancelled", customerId: "customer", amountCents: 26014, frequency: "monthly", customer: { id: "customer", lunarpayCustomerId: 10 } }));
  mock.method(prisma.subscription, "findFirst", async () => null);
  mock.method(prisma.paymentMethod, "findFirst", async () => ({ id: "card", lunarpayPaymentMethodId: 42, lunarpayCustomerId: 10 }));
  mock.method(prisma.subscriptionRestartClaim, "create", async () => ({}));
  const cleanup = mock.method(prisma.subscriptionRestartClaim, "deleteMany", async () => ({ count: 1 }));
  mock.method(lunarpay, "createSubscription", async () => { throw new LunarPayError("Processor unavailable", 503); });
  const result = await restart(request({ paymentMethodId: "card", startOn: "2099-01-01" }), context("subscription"));
  assert.equal(result?.status, 503);
  assert.deepEqual(cleanup.mock.calls[0].arguments[0], { where: { restartedFromId: { equals: "subscription" } } });
});
