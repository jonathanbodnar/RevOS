import assert from "node:assert/strict";
import test from "node:test";
import { coreMetrics, segmentalMetrics, kgToLbs, EMPTY_ROW } from "./inbody-display";

test("kgToLbs converts using the standard factor", () => {
  assert.equal(Math.round(kgToLbs(100) * 100) / 100, 220.46);
  assert.equal(Math.round(kgToLbs(45.3) * 10) / 10, 99.9);
  assert.equal(kgToLbs(0), 0);
});

test("core metrics render mass in lbs, leaving BMI and percentages alone", () => {
  const row = {
    ...EMPTY_ROW,
    weightKg: 101.9,
    totalBodyWaterKg: 41.3,
    dryLeanMassKg: 21,
    skeletalMuscleMassKg: 45.3,
    bodyFatMassKg: 22.7,
    bmi: 30.5,
    percentBodyFat: 23,
  };
  const byLabel = Object.fromEntries(coreMetrics(row).map((m) => [m.label, m.value]));

  assert.equal(byLabel["Weight"], "224.7 lbs");
  assert.equal(byLabel["Dry Lean Mass"], "46.3 lbs");
  assert.equal(byLabel["SMM (Skeletal Muscle Mass)"], "99.9 lbs");
  // BMI is an index and PBF a proportion — converting either would be wrong.
  assert.equal(byLabel["BMI"], "30.5");
  assert.equal(byLabel["PBF (Percent Body Fat)"], "23%");
});

test("segmental lean converts mass but not percent-of-ideal", () => {
  const row = { ...EMPTY_ROW, segLeanTrunkKg: 34.5, segLeanTrunkPct: 122.3 };
  const trunk = segmentalMetrics(row).find((s) => s.segment === "Trunk")!;
  assert.equal(trunk.mass, "76.1 lbs");
  // Percent of ideal legitimately exceeds 100 and is unitless.
  assert.equal(trunk.pct, "122.3%");
});

test("missing values stay em-dashes rather than converting to 0", () => {
  const byLabel = Object.fromEntries(coreMetrics(EMPTY_ROW).map((m) => [m.label, m.value]));
  assert.equal(byLabel["Weight"], "—");
  assert.equal(byLabel["BMI"], "—");
});
