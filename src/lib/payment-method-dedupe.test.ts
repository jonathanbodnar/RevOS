import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { prisma } from "./prisma";
import { upsertVaultedCard } from "./payment-method-dedupe";
import { isolatePrisma } from "./test-helpers/prisma";

let restorePrisma: () => void;
beforeEach(() => { restorePrisma = isolatePrisma(); });
afterEach(() => { mock.restoreAll(); restorePrisma(); });

const input = {
  customerId: "customer-1",
  setDefault: true,
  card: {
    lunarpayPaymentMethodId: 42,
    lunarpayCustomerId: 10,
    sourceType: "cc",
    lastDigits: "1234",
    nameHolder: null,
    expMonth: "12",
    expYear: "2030",
  },
};

test("invalid customer ids and card metadata fail before any database access", async () => {
  const read = mock.method(prisma.paymentMethod, "findUnique", () => { throw new Error("Unexpected database access"); });
  for (const customerId of [{ not: "" }, { $ne: null }, ["customer-1"], null, undefined, 12, ""]) {
    await assert.rejects(upsertVaultedCard({ ...input, customerId } as never), { name: "ZodError" });
  }
  await assert.rejects(upsertVaultedCard({ ...input, card: { ...input.card, lastDigits: { not: null } } } as never), { name: "ZodError" });
  await assert.rejects(upsertVaultedCard({ ...input, card: { ...input.card, lunarpayPaymentMethodId: { gt: 0 } } } as never), { name: "ZodError" });
  assert.equal(read.mock.callCount(), 0);
});

test("a vault id belonging to another customer cannot change cards or defaults", async () => {
  mock.method(prisma.paymentMethod, "findUnique", async () => ({ id: "other-card", customerId: "customer-2" }));
  const defaults = mock.method(prisma.paymentMethod, "updateMany", async () => ({ count: 0 }));
  const update = mock.method(prisma.paymentMethod, "update", async () => null);
  await assert.rejects(upsertVaultedCard(input), /different customer/);
  assert.equal(defaults.mock.callCount(), 0);
  assert.equal(update.mock.callCount(), 0);
});

test("re-adding the same card preserves its row and vault owner while renewing expiry", async () => {
  mock.method(prisma.paymentMethod, "findUnique", async () => null);
  const find = mock.method(prisma.paymentMethod, "findFirst", async () => ({ id: "existing-card", customerId: input.customerId, lunarpayCustomerId: 10, nameHolder: "Existing name" }));
  const defaults = mock.method(prisma.paymentMethod, "updateMany", async () => ({ count: 1 }));
  const update = mock.method(prisma.paymentMethod, "update", async () => ({ id: "existing-card" }));
  assert.deepEqual(await upsertVaultedCard({ ...input, card: { ...input.card, lunarpayCustomerId: null } }), { id: "existing-card", deduped: true });
  assert.deepEqual(find.mock.calls[0].arguments[0]?.where, { customerId: { equals: "customer-1" }, lastDigits: "1234", sourceType: "cc", isActive: true });
  assert.deepEqual(defaults.mock.calls[0].arguments[0], { where: { customerId: { equals: "customer-1" }, isDefault: true }, data: { isDefault: false } });
  assert.deepEqual(update.mock.calls[0].arguments[0], {
    where: { id: "existing-card" },
    data: { lunarpayPaymentMethodId: 42, lunarpayCustomerId: 10, nameHolder: "Existing name", expMonth: "12", expYear: "2030", isActive: true, isDefault: true },
  });
});

test("a new non-default card is created without clearing the existing default", async () => {
  mock.method(prisma.paymentMethod, "findUnique", async () => null);
  mock.method(prisma.paymentMethod, "findFirst", async () => null);
  const defaults = mock.method(prisma.paymentMethod, "updateMany", async () => ({ count: 0 }));
  const create = mock.method(prisma.paymentMethod, "create", async () => ({ id: "new-card" }));
  assert.deepEqual(await upsertVaultedCard({ ...input, setDefault: false }), { id: "new-card", deduped: false });
  assert.equal(defaults.mock.callCount(), 0);
  assert.deepEqual(create.mock.calls[0].arguments[0]?.data, { ...input.card, customerId: "customer-1", isDefault: false });
});
