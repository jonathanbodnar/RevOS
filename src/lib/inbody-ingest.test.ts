import { test } from "node:test";
import assert from "node:assert/strict";
import { metricColumns } from "./inbody-ingest";
import { EMPTY_METRICS } from "./inbody";

test("segmental-lean % above 100 is preserved (percent-of-ideal)", () => {
  // Muscular patients routinely exceed 100% — the repo's own fixture uses
  // 101.4%. It must NOT be clamped to null.
  const cols = metricColumns({
    ...EMPTY_METRICS,
    segLeanRightArmPct: 101.4,
    segLeanTrunkPct: 128,
    percentBodyFat: 22.5,
  });
  assert.equal(cols.segLeanRightArmPct, 101.4);
  assert.equal(cols.segLeanTrunkPct, 128);
  assert.equal(cols.percentBodyFat, 22.5);
});

test("impossible metrics are rejected to null", () => {
  const cols = metricColumns({
    ...EMPTY_METRICS,
    weightKg: -5, // impossible
    bmi: 4, // below floor
    percentBodyFat: 150, // impossible body-fat %
    segLeanRightArmPct: 999, // beyond any plausible reading
  });
  assert.equal(cols.weightKg, null);
  assert.equal(cols.bmi, null);
  assert.equal(cols.percentBodyFat, null);
  assert.equal(cols.segLeanRightArmPct, null);
});
