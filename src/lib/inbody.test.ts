import assert from "node:assert/strict";
import test from "node:test";
import {
  formatTestDatetimes,
  normalizeInBodyResult,
  parseTestDatetimes,
  parseTodayMeasurementRecords,
} from "./inbody";

test("normalizes abbreviated, descriptive, and nested InBody fields", () => {
  const metrics = normalizeInBodyResult({
    WT: "81.2 kg",
    "BMI(BodyMassIndex)": "24.7",
    composition: {
      "SMM(SkeletalMuscleMass)": 35.4,
      segmental: { SLM_RA: "3.62", PSLMRA: "101.4%" },
    },
  });

  assert.equal(metrics.weightKg, 81.2);
  assert.equal(metrics.bmi, 24.7);
  assert.equal(metrics.skeletalMuscleMassKg, 35.4);
  assert.equal(metrics.segLeanRightArmKg, 3.62);
  assert.equal(metrics.segLeanRightArmPct, 101.4);
});

test("normalizes wrapped GetTodayMeasurements responses and aliases", () => {
  assert.deepEqual(
    parseTodayMeasurementRecords({
      Results: [
        { user_id: "patient-1", user_token: "15551234567", test_datetimes: "20260714123045" },
        { UserID: "missing-date", UserToken: "15550000000" },
      ],
    }),
    [{ UserID: "patient-1", UserToken: "15551234567", DateTimes: "20260714123045" }],
  );
});

test("rejects rollover dates and round-trips valid InBody timestamps", () => {
  assert.equal(parseTestDatetimes("20260230120000"), null);
  const parsed = parseTestDatetimes("20260714123045");
  assert.ok(parsed);
  assert.equal(formatTestDatetimes(parsed), "20260714123045");
});
