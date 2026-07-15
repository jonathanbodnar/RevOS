import test from "node:test";
import assert from "node:assert/strict";
import {
  lunarpayCostCents,
  netChargeAmountCents,
  recurringEconomics,
} from "./reporting";

test("refunds reduce a charge to the amount still collected", () => {
  assert.equal(netChargeAmountCents(10_000, 2_500), 7_500);
  assert.equal(netChargeAmountCents(10_000, 10_000), 0);
  assert.equal(netChargeAmountCents(10_000, 15_000), 0);
});

test("a fully refunded charge contributes no LunarPay cost or revenue share", () => {
  assert.equal(lunarpayCostCents(0), 0);
  const economics = recurringEconomics(0, {
    revosDownPaymentSharePct: 50,
    implementorFeeCents: 14_000,
    revosRecurringShareCents: 7_500,
  });
  assert.equal(economics.grossCents, 0);
  assert.equal(economics.revosShareCents, 0);
  assert.equal(economics.clinicShareCents, 0);
  assert.equal(economics.lunarpayCostCents, 0);
});
