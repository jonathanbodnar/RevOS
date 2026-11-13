import { test } from "node:test";
import assert from "node:assert/strict";
import { LEADERBOARD_METRICS, rankImprovements, type LeaderboardScan } from "./leaderboard";
import { LBS_PER_KG } from "./inbody-display";

const metric = (key: string) => LEADERBOARD_METRICS.find((m) => m.key === key)!;
const lbs = (v: number) => v / LBS_PER_KG; // a reading entered in pounds, stored in kg

function scan(day: number, values: Partial<Omit<LeaderboardScan, "testedAt">>): LeaderboardScan {
  return {
    testedAt: new Date(Date.UTC(2026, 6, day)),
    weightKg: null,
    bodyFatMassKg: null,
    percentBodyFat: null,
    skeletalMuscleMassKg: null,
    ...values,
  };
}

test("ranks pounds lost from the first scan to the latest, whatever order scans arrive in", () => {
  const { rows, eligible } = rankImprovements(
    [
      { id: "a", name: "Ana", scans: [scan(20, { weightKg: lbs(190) }), scan(1, { weightKg: lbs(200) })] },
      // The middle scan doesn't matter — only first and latest.
      { id: "b", name: "Ben", scans: [scan(1, { weightKg: lbs(250) }), scan(10, { weightKg: lbs(260) }), scan(30, { weightKg: lbs(230) })] },
    ],
    metric("weight"),
  );
  assert.equal(eligible, 2);
  assert.deepEqual(rows.map((r) => [r.rank, r.id, Math.round(r.improvement * 10) / 10]), [
    [1, "b", 20],
    [2, "a", 10],
  ]);
  assert.equal(Math.round(rows[0].start), 250);
  assert.equal(Math.round(rows[0].latest), 230);
  assert.equal(rows[0].scans, 3);
  assert.deepEqual(rows[0].firstAt, new Date(Date.UTC(2026, 6, 1)));
  assert.deepEqual(rows[0].latestAt, new Date(Date.UTC(2026, 6, 30)));
});

test("needs two readings of the measure; scans without it don't count", () => {
  const { rows, eligible } = rankImprovements(
    [
      { id: "one-scan", name: "A", scans: [scan(1, { weightKg: lbs(200) })] },
      // Two scans, but only one carries body fat %.
      { id: "half-data", name: "B", scans: [scan(1, { percentBodyFat: 40 }), scan(9, { weightKg: lbs(180) })] },
      { id: "ok", name: "C", scans: [scan(1, { percentBodyFat: 40 }), scan(9, { percentBodyFat: 36.5 })] },
    ],
    metric("pbf"),
  );
  assert.equal(eligible, 1);
  assert.deepEqual(rows.map((r) => [r.id, r.improvement]), [["ok", 3.5]]);
});

test("leaves off patients who got worse, held steady, or moved less than the board shows", () => {
  const { rows, eligible } = rankImprovements(
    [
      { id: "gained", name: "A", scans: [scan(1, { weightKg: lbs(200) }), scan(9, { weightKg: lbs(205) })] },
      { id: "same", name: "B", scans: [scan(1, { weightKg: lbs(200) }), scan(9, { weightKg: lbs(200) })] },
      { id: "rounds-to-zero", name: "C", scans: [scan(1, { weightKg: lbs(200) }), scan(9, { weightKg: lbs(199.96) })] },
      { id: "lost", name: "D", scans: [scan(1, { weightKg: lbs(200) }), scan(9, { weightKg: lbs(199.9) })] },
    ],
    metric("weight"),
  );
  assert.equal(eligible, 4);
  assert.deepEqual(rows.map((r) => r.id), ["lost"]);
});

test("muscle ranks gains, not losses", () => {
  const { rows } = rankImprovements(
    [
      { id: "lost-muscle", name: "A", scans: [scan(1, { skeletalMuscleMassKg: lbs(80) }), scan(9, { skeletalMuscleMassKg: lbs(78) })] },
      { id: "gained-muscle", name: "B", scans: [scan(1, { skeletalMuscleMassKg: lbs(80) }), scan(9, { skeletalMuscleMassKg: lbs(83) })] },
    ],
    metric("muscle"),
  );
  assert.deepEqual(rows.map((r) => [r.id, Math.round(r.improvement * 10) / 10]), [["gained-muscle", 3]]);
});

test("percent of body weight ranks a smaller patient's loss above a larger one's", () => {
  const patients = [
    { id: "big", name: "A", scans: [scan(1, { weightKg: lbs(300) }), scan(9, { weightKg: lbs(270) })] }, // 30 lbs, 10%
    { id: "small", name: "B", scans: [scan(1, { weightKg: lbs(150) }), scan(9, { weightKg: lbs(127.5) })] }, // 22.5 lbs, 15%
  ];
  assert.deepEqual(rankImprovements(patients, metric("weight")).rows.map((r) => r.id), ["big", "small"]);
  const pct = rankImprovements(patients, metric("weight_pct")).rows;
  assert.deepEqual(pct.map((r) => [r.id, Math.round(r.improvement * 10) / 10]), [["small", 15], ["big", 10]]);
});

test("patients who read the same share a place, and the next place is skipped", () => {
  const lost = (id: string, name: string, pounds: number) => ({
    id,
    name,
    scans: [scan(1, { weightKg: lbs(200) }), scan(9, { weightKg: lbs(200 - pounds) })],
  });
  const { rows } = rankImprovements(
    // 5.04 and 5.01 both show as 5.0, so they tie; ties list alphabetically.
    [lost("z", "Zoe", 5.01), lost("t", "Tia", 9), lost("m", "Max", 5.04), lost("l", "Lee", 2)],
    metric("weight"),
  );
  assert.deepEqual(rows.map((r) => [r.rank, r.name]), [
    [1, "Tia"],
    [2, "Max"],
    [2, "Zoe"],
    [4, "Lee"],
  ]);
});
