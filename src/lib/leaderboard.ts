/**
 * Patient leaderboard — ranks a clinic's patients by how much their InBody
 * results improved from their first scan to their latest. That is the same
 * "since first test" reading as the trend chart on a profile's InBody tab.
 *
 * A patient needs at least two scans carrying the measure to be ranked, and
 * only those whose latest reading beats their first make the board.
 *
 * UNITS: masses are stored in kg (see inbody-display.ts) and converted to lbs
 * before any arithmetic here, so every number this returns is in display units.
 */
import { kgToLbs } from "./inbody-display";

export type LeaderboardScan = {
  testedAt: Date;
  weightKg: number | null;
  bodyFatMassKg: number | null;
  percentBodyFat: number | null;
  skeletalMuscleMassKg: number | null;
};

type ScanField = Exclude<keyof LeaderboardScan, "testedAt">;

export type LeaderboardMetric = {
  key: string;
  label: string;
  description: string;
  field: ScanField;
  /** Which direction is an improvement. */
  better: "down" | "up";
  /** Stored in kg, shown (and ranked) in lbs. */
  fromKg?: boolean;
  /** Rank by the change as a percentage of the first reading. */
  relative?: boolean;
  /** Unit of the first/latest readings. */
  unit: string;
  /** Unit of the improvement figure. */
  changeUnit: string;
};

export const LEADERBOARD_METRICS = [
  {
    key: "weight",
    label: "Weight lost",
    description: "Pounds of body weight lost, first InBody scan to latest.",
    field: "weightKg",
    better: "down",
    fromKg: true,
    unit: " lbs",
    changeUnit: " lbs",
  },
  {
    key: "weight_pct",
    label: "% weight lost",
    description:
      "Share of starting body weight lost — fairer across patients of different sizes.",
    field: "weightKg",
    better: "down",
    fromKg: true,
    relative: true,
    unit: " lbs",
    changeUnit: "%",
  },
  {
    key: "fat",
    label: "Fat lost",
    description: "Pounds of body fat mass lost, first InBody scan to latest.",
    field: "bodyFatMassKg",
    better: "down",
    fromKg: true,
    unit: " lbs",
    changeUnit: " lbs",
  },
  {
    key: "pbf",
    label: "Body fat % drop",
    description: "Drop in percent body fat (PBF), first InBody scan to latest.",
    field: "percentBodyFat",
    better: "down",
    unit: "%",
    changeUnit: "%",
  },
  {
    key: "muscle",
    label: "Muscle gained",
    description: "Pounds of skeletal muscle mass (SMM) gained, first InBody scan to latest.",
    field: "skeletalMuscleMassKg",
    better: "up",
    fromKg: true,
    unit: " lbs",
    changeUnit: " lbs",
  },
] as const satisfies readonly LeaderboardMetric[];

export type LeaderboardRow = {
  rank: number;
  id: string;
  name: string;
  /** First and latest readings, in display units. */
  start: number;
  latest: number;
  /** How much better the latest reading is (> 0), in `changeUnit`. */
  improvement: number;
  /** Scans carrying this measure. */
  scans: number;
  firstAt: Date;
  latestAt: Date;
};

/** One decimal — the precision the board shows, and so the one it ranks at. */
function shown(v: number): number {
  return Math.round(v * 10) / 10;
}

export function rankImprovements(
  patients: { id: string; name: string; scans: LeaderboardScan[] }[],
  metric: LeaderboardMetric,
): { rows: LeaderboardRow[]; eligible: number } {
  let eligible = 0;
  const improved: Omit<LeaderboardRow, "rank">[] = [];

  for (const p of patients) {
    const readings = p.scans
      .filter((s) => s[metric.field] != null)
      .sort((a, b) => a.testedAt.getTime() - b.testedAt.getTime());
    if (readings.length < 2) continue;
    eligible += 1;

    const first = readings[0];
    const last = readings[readings.length - 1];
    const toShown = (v: number) => (metric.fromKg ? kgToLbs(v) : v);
    const start = toShown(first[metric.field] as number);
    const latest = toShown(last[metric.field] as number);
    const change = metric.better === "down" ? start - latest : latest - start;
    const improvement = metric.relative
      ? start > 0
        ? (change / start) * 100
        : 0
      : change;
    // A change that rounds to 0.0 would read as no change on the board.
    if (!(shown(improvement) > 0)) continue;

    improved.push({
      id: p.id,
      name: p.name,
      start,
      latest,
      improvement,
      scans: readings.length,
      firstAt: first.testedAt,
      latestAt: last.testedAt,
    });
  }

  improved.sort(
    (a, b) =>
      shown(b.improvement) - shown(a.improvement) || a.name.localeCompare(b.name),
  );

  // Competition ranking on the shown value: patients who read the same share a
  // place, and the next place is skipped (1, 2, 2, 4).
  let rank = 0;
  const rows = improved.map((r, i) => {
    if (i === 0 || shown(r.improvement) !== shown(improved[i - 1].improvement)) {
      rank = i + 1;
    }
    return { rank, ...r };
  });

  return { rows, eligible };
}
