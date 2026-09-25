import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { lunarpay, LunarPayError } from "./lunarpay";
import { isolatePrisma } from "./test-helpers/prisma";
import { recordLunarPayCharge } from "./charge-record";
import { POST as payLink } from "../app/api/public/payment-link/[token]/route";
import { POST as lunarpayWebhook } from "../app/api/webhooks/lunarpay/route";

// LunarPay fires charge.succeeded (not awaited) right before it answers
// POST /charges, so the webhook can insert the charge id before checkout does.
const uniqueViolation = () =>
  new Prisma.PrismaClientKnownRequestError(
    "Unique constraint failed on the fields: (`lunarpayChargeId`)",
    { code: "P2002", clientVersion: "test", meta: { target: ["lunarpayChargeId"] } },
  );

let restorePrisma: () => void;
beforeEach(() => {
  restorePrisma = isolatePrisma();
  mock.method(prisma.auditLog, "create", async () => ({}));
});
afterEach(() => { mock.restoreAll(); restorePrisma(); });

const charge = {
  clinicId: "clinic-1",
  customerId: "customer-1",
  paymentMethodId: "pm-1",
  paymentLinkId: "link-1",
  lunarpayChargeId: "2063",
  fortisTransactionId: null,
  amountCents: 155889,
  status: "paid",
  paymentMethodType: "cc",
  description: null,
};

test("records the charge when our insert lands first", async () => {
  const create = mock.method(prisma.charge, "create", async () => ({ id: "row-1" }));
  const update = mock.method(prisma.charge, "update", async () => { throw new Error("unexpected"); });
  assert.deepEqual(await recordLunarPayCharge(charge), { id: "row-1" });
  assert.deepEqual(create.mock.calls[0].arguments[0], { data: charge });
  assert.equal(update.mock.callCount(), 0);
});

test("when the webhook recorded it first, fills in the link and card without touching settlement", async () => {
  mock.method(prisma.charge, "create", async () => { throw uniqueViolation(); });
  const update = mock.method(prisma.charge, "update", async () => ({ id: "webhook-row" }));
  assert.deepEqual(await recordLunarPayCharge(charge), { id: "webhook-row" });
  assert.deepEqual(update.mock.calls[0].arguments[0], {
    where: { lunarpayChargeId: "2063" },
    // No status/amount/refund/createdAt, and nulls (fortis id, description)
    // leave the webhook's values alone.
    data: {
      clinicId: "clinic-1",
      customerId: "customer-1",
      paymentMethodId: "pm-1",
      paymentLinkId: "link-1",
      fortisTransactionId: undefined,
      paymentMethodType: "cc",
      description: undefined,
    },
  });
});

test("any other database error still propagates", async () => {
  mock.method(prisma.charge, "create", async () => { throw new Error("connection reset"); });
  const update = mock.method(prisma.charge, "update", async () => ({}));
  await assert.rejects(recordLunarPayCharge(charge), /connection reset/);
  assert.equal(update.mock.callCount(), 0);
});

// ── The 9/22–9/23 incident, through the real checkout handler ──────────────

const masterLink = {
  id: "link-1",
  token: "tok",
  mode: "master",
  status: "open",
  clinicId: "clinic-1",
  clinic: { name: "Frisco" },
  amountCents: 0,
  metadataJson: null,
  description: "Master link — payer configures amounts",
};

function mockCheckoutUpToCharge() {
  mock.method(prisma.checkoutSession, "findUnique", async () => masterLink);
  mock.method(lunarpay, "createCustomer", async () => ({ data: { id: 1251 } }));
  mock.method(prisma.customer, "findUnique", async () => null);
  mock.method(prisma.customer, "create", async () => ({ id: "customer-1", lunarpayCustomerId: 1251 }));
  mock.method(prisma.paymentMethod, "count", async () => 0);
  mock.method(lunarpay, "savePaymentMethod", async () => ({
    data: { id: 1024, isDefault: true, sourceType: "cc", lastDigits: "2317", nameHolder: "Pat Doe", expMonth: "12", expYear: "2030" },
  }));
  mock.method(prisma.paymentMethod, "findUnique", async () => null);
  mock.method(prisma.paymentMethod, "findFirst", async () => null);
  mock.method(prisma.paymentMethod, "updateMany", async () => ({ count: 0 }));
  mock.method(prisma.paymentMethod, "create", async () => ({ id: "pm-1" }));
  mock.method(prisma.paymentMethod, "findUniqueOrThrow", async () => ({ id: "pm-1" }));
  return mock.method(lunarpay, "createCharge", async () => ({
    data: { id: "2063", amount: 155889, status: "paid", paymentMethod: "cc", customerId: 1251, paymentMethodId: 1024 },
  }));
}

const checkout = () =>
  payLink(
    new Request("http://localhost/api/public/payment-link/tok", {
      method: "POST",
      body: JSON.stringify({
        tokenizeId: "vault-1",
        paymentMethod: "cc",
        lastFour: "2317",
        email: "pat@example.com",
        firstName: "Pat",
        lastName: "Doe",
        phone: "5555555555",
        master: { downPaymentCents: 150000, split: false, subscription: true, subscriptionDate: "2026-10-22" },
      }),
    }),
    { params: Promise.resolve({ token: "tok" }) },
  );

test("checkout still starts the subscription when the webhook recorded the down payment first", async () => {
  const createCharge = mockCheckoutUpToCharge();
  mock.method(prisma.charge, "create", async () => { throw uniqueViolation(); });
  const chargeUpdate = mock.method(prisma.charge, "update", async () => ({ id: "webhook-row" }));
  mock.method(lunarpay, "createSubscription", async () => ({
    data: { id: 622, status: "active", startOn: "2026-09-22T00:00:00Z", nextPaymentOn: "2026-10-22T00:00:00Z" },
  }));
  const subCreate = mock.method(prisma.subscription, "create", async () => ({}));

  const res = await checkout();

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  assert.equal(createCharge.mock.callCount(), 1);
  const linked = chargeUpdate.mock.calls[0].arguments[0];
  assert.deepEqual(linked?.where, { lunarpayChargeId: "2063" });
  assert.equal(linked?.data.paymentLinkId, "link-1");
  assert.equal(linked?.data.paymentMethodId, "pm-1");
  assert.equal(linked?.data.description, "Master link — payer configures amounts");
  assert.equal(subCreate.mock.callCount(), 1);
  assert.equal(subCreate.mock.calls[0].arguments[0]?.data.lunarpaySubscriptionId, 622);
  assert.equal(subCreate.mock.calls[0].arguments[0]?.data.paymentLinkId, "link-1");
});

test("a failure after the card is charged tells the payer not to pay again", async () => {
  mockCheckoutUpToCharge();
  mock.method(prisma.charge, "create", async () => ({ id: "row-1" }));
  mock.method(lunarpay, "createSubscription", async () => {
    throw new LunarPayError("Validation error", 400);
  });
  const audit = mock.method(prisma.auditLog, "create", async () => ({}));

  const res = await checkout();
  const body = await res.json();

  assert.equal(res.ok, false);
  assert.equal(body.charged, true);
  assert.match(body.error, /\$1,558\.89 went through/);
  assert.match(body.error, /don't pay again/);
  const incident = audit.mock.calls
    .map((c) => c.arguments[0]?.data)
    .find((d) => d?.action === "payment_link.incomplete");
  assert.ok(incident, "an admin-visible audit row records the half-finished checkout");
  assert.equal(incident.targetId, "customer-1");
  const meta = JSON.parse(String(incident.metadata));
  assert.equal(meta.stage, "createSubscription.master");
  assert.equal(meta.lunarpayChargeId, "2063");
  assert.equal(meta.master.subscriptionDate, "2026-10-22");
});

test("a decline is still a plain error (nothing was charged)", async () => {
  mockCheckoutUpToCharge();
  mock.method(lunarpay, "createCharge", async () => { throw new LunarPayError("Card declined", 402); });
  const create = mock.method(prisma.charge, "create", async () => ({}));
  mock.method(prisma.clinic, "findUnique", async () => null);

  const res = await checkout();
  const body = await res.json();

  assert.equal(res.status, 402);
  assert.equal(body.charged, undefined);
  assert.match(body.error, /Card declined/);
  assert.equal(create.mock.calls[0].arguments[0]?.data.status, "failed");
});

// ── The mirror race inside the webhook handler ─────────────────────────────

test("webhook settles checkout's row when checkout inserts between its lookup and insert", async () => {
  process.env.LUNARPAY_WEBHOOK_SECRET = "whsec_test";
  const raw = JSON.stringify({
    event: "charge.succeeded",
    timestamp: "2026-09-22T19:16:43.400Z",
    data: { transaction_id: 2063, customer_id: 1251, amount_cents: 155889, payment_method: "cc" },
  });
  const ts = "2026-09-22T19:16:43.400Z";
  const sig = "sha256=" + crypto.createHmac("sha256", "whsec_test").update(`${ts}.${raw}`).digest("hex");

  mock.method(prisma.customer, "findFirst", async () => ({ id: "customer-1", clinicId: "clinic-1" }));
  const checkoutRow = { id: "row-1", status: "paid", description: "Master link — payer configures amounts", paymentMethodType: "cc" };
  let lookups = 0;
  mock.method(prisma.charge, "findUnique", async () => (lookups++ === 0 ? null : checkoutRow));
  mock.method(prisma.charge, "create", async () => { throw uniqueViolation(); });
  const update = mock.method(prisma.charge, "update", async () => ({}));
  const audit = mock.method(prisma.auditLog, "create", async () => ({}));

  const res = await lunarpayWebhook(
    new Request("http://localhost/api/webhooks/lunarpay", {
      method: "POST",
      headers: { "x-lunarpay-signature": sig, "x-lunarpay-timestamp": ts },
      body: raw,
    }),
  );

  assert.equal(res.status, 200);
  assert.deepEqual(update.mock.calls[0].arguments[0]?.where, { id: "row-1" });
  assert.equal(update.mock.calls[0].arguments[0]?.data.description, "Master link — payer configures amounts");
  const settled = audit.mock.calls
    .map((c) => c.arguments[0]?.data)
    .find((d) => d?.action === "charge.succeeded.webhook");
  assert.ok(settled, "the webhook completed instead of dying on the unique constraint");
  assert.equal(JSON.parse(String(settled.metadata)).newlySettled, false);
});
