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

// Field names as an InBody380H actually emits them. The previous fixture used
// invented names (SLM_RA, PSLMRA) that no device sends, which is how a mapping
// gap that left 11 of 17 columns permanently NULL shipped green.
test("maps the real InBody full-endpoint field names", () => {
  const metrics = normalizeInBodyResult({
    Weight: "101.7",
    "BMI(BodyMassIndex)": "29.6",
    "PBF(PercentBodyFat)": "22.4",
    "SMM(SkeletalMuscleMass)": "44.6",
    "TBW(TotalBodyWater)": "58.1",
    "BFM(BodyFatMass)": "22.7",
    "DLM(DryLeanMass)": "20.9",
    LeanMassofRightArm: "5.28",
    LeanMassofLeftArm: "5.13",
    LeanMassofTrunk: "36.2",
    LeanMassofRightLeg: "13.4",
    LeanMassofLeftLeg: "13.6",
    "LeanMass(%)ofRightArm": "134.3",
    "LeanMass(%)ofLeftArm": "129.0",
    "LeanMass(%)ofTrunk": "117.2",
    "LeanMass(%)ofRightLeg": "98.3",
    "LeanMass(%)ofLeftLeg": "100.5",
  });

  assert.equal(metrics.dryLeanMassKg, 20.9);
  assert.equal(metrics.segLeanTrunkKg, 36.2);
  assert.equal(metrics.segLeanLeftLegKg, 13.6);
  // Regression guard for the normKey collision: stripping "%" would make
  // "LeanMass(%)ofRightArm" normalize identically to "LeanMassofRightArm", so
  // the percent column would silently receive the kg value (5.28).
  assert.equal(metrics.segLeanRightArmPct, 134.3);
  assert.equal(metrics.segLeanLeftLegPct, 100.5);
  assert.ok(Object.values(metrics).every((v) => v !== null), "all 17 metrics map");
});

test("maps the real InBody abbreviated field names", () => {
  const metrics = normalizeInBodyResult({
    WT: "101.7",
    BMI: "29.6",
    PBF: "22.4",
    SMM: "44.6",
    TBW: "58.1",
    BFM: "22.7",
    DM: "20.9",
    LRA: "5.28",
    LLA: "5.13",
    LT: "36.2",
    LRL: "13.4",
    LLL: "13.6",
    PILRA: "134.3",
    PILLA: "129.0",
    PILT: "117.2",
    PILRL: "98.3",
    PILLL: "100.5",
  });

  assert.equal(metrics.dryLeanMassKg, 20.9);
  assert.equal(metrics.segLeanRightArmKg, 5.28);
  assert.equal(metrics.segLeanRightArmPct, 134.3);
  assert.ok(Object.values(metrics).every((v) => v !== null), "all 17 metrics map");
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
