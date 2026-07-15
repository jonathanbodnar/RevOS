import test from "node:test";
import assert from "node:assert/strict";
import {
  expectedRecurringCycles,
  reconChargeId,
  stepBack,
} from "./subscription-reconcile";

test("monthly cycle reconstruction clamps month ends without drifting", () => {
  const latest = new Date("2025-03-31T15:30:00.000Z");
  assert.equal(stepBack(latest, "monthly", 1).toISOString(), "2025-02-28T15:30:00.000Z");
  assert.equal(stepBack(latest, "monthly", 2).toISOString(), "2025-01-31T15:30:00.000Z");
});

test("yearly reconstruction clamps leap day", () => {
  const leapDay = new Date("2024-02-29T08:00:00.000Z");
  assert.equal(stepBack(leapDay, "yearly", 1).toISOString(), "2023-02-28T08:00:00.000Z");
});

test("successTrxns produces every expected cycle, newest first", () => {
  const cycles = expectedRecurringCycles(
    new Date("2026-07-15T12:00:00.000Z"),
    "monthly",
    3,
  );
  assert.deepEqual(
    cycles.map((cycle) => cycle.toISOString().slice(0, 10)),
    ["2026-07-15", "2026-06-15", "2026-05-15"],
  );
  assert.equal(reconChargeId(42, cycles[2]), "recon:sub:42:2026-05-15");
});
