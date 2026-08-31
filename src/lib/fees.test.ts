import assert from "node:assert/strict";
import test from "node:test";
import { calcFee, baseCentsFromTotal } from "./fees";

test("baseCentsFromTotal inverts calcFee", () => {
  // The real master-link plan: $250.00 base bills as $260.14.
  assert.equal(calcFee(25000).totalCents, 26014);
  assert.equal(baseCentsFromTotal(26014), 25000);

  // Round-trips across a wide range, including values where calcFee's
  // Math.round pushes the naive inverse a cent off.
  for (let base = 50; base <= 500000; base += 137) {
    const { totalCents } = calcFee(base);
    assert.equal(
      baseCentsFromTotal(totalCents),
      base,
      `failed round trip for base ${base} (total ${totalCents})`,
    );
  }
});

test("baseCentsFromTotal refuses unreachable totals", () => {
  // Below the flat fee there is no base that produces this total.
  assert.equal(baseCentsFromTotal(10), null);
});
