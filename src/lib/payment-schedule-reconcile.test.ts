import test from "node:test";
import assert from "node:assert/strict";
import {
  FAILURE_NOTIFY_WINDOW_DAYS,
  reconScheduleChargeId,
  shouldNotifyFailure,
} from "./payment-schedule-reconcile";

test("schedule placeholders are stable per LunarPay schedule item", () => {
  assert.equal(reconScheduleChargeId(91, 7), "recon:schedule:91:7");
  assert.notEqual(reconScheduleChargeId(91, 7), reconScheduleChargeId(91, 8));
});

test("recent installment declines alert; stale ones only record", () => {
  const now = new Date("2026-07-15T12:00:00.000Z");
  const recent = new Date("2026-07-14T00:00:00.000Z");
  const stale = new Date(
    now.getTime() - (FAILURE_NOTIFY_WINDOW_DAYS + 2) * 24 * 60 * 60 * 1000,
  );
  assert.equal(shouldNotifyFailure(recent, now), true);
  assert.equal(shouldNotifyFailure(stale, now), false);
});
