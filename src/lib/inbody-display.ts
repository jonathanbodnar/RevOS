/**
 * Shared display helpers for InBody metrics (used by both the admin InBody
 * page and the customer profile).
 *
 * UNITS: the device and the API report metric, and every mass column is stored
 * in KILOGRAMS — that never changes, so historical rows stay comparable and
 * nothing has to be migrated. Conversion to pounds happens only here, at the
 * point of display, because that is what the clinics read. Anything showing a
 * mass to a human must go through `lbs()`; anything doing arithmetic on a
 * stored value is working in kg.
 */

/** Pounds per kilogram. */
export const LBS_PER_KG = 2.20462262;

export function kgToLbs(v: number): number {
  return v * LBS_PER_KG;
}

export type InBodyTestRow = {
  weightKg: number | null;
  totalBodyWaterKg: number | null;
  dryLeanMassKg: number | null;
  skeletalMuscleMassKg: number | null;
  bodyFatMassKg: number | null;
  bmi: number | null;
  percentBodyFat: number | null;
  segLeanRightArmKg: number | null;
  segLeanLeftArmKg: number | null;
  segLeanTrunkKg: number | null;
  segLeanRightLegKg: number | null;
  segLeanLeftLegKg: number | null;
  segLeanRightArmPct: number | null;
  segLeanLeftArmPct: number | null;
  segLeanTrunkPct: number | null;
  segLeanRightLegPct: number | null;
  segLeanLeftLegPct: number | null;
};

/** Stored kg → displayed lbs. */
function lbs(v: number | null): string {
  return v === null ? "—" : `${round(kgToLbs(v))} lbs`;
}
function idx(v: number | null): string {
  return v === null ? "—" : `${round(v)}`;
}
function pct(v: number | null): string {
  return v === null ? "—" : `${round(v)}%`;
}
function round(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}

/** All-null row — a base for tests and for rendering a scan with no data. */
export const EMPTY_ROW: InBodyTestRow = {
  weightKg: null,
  totalBodyWaterKg: null,
  dryLeanMassKg: null,
  skeletalMuscleMassKg: null,
  bodyFatMassKg: null,
  bmi: null,
  percentBodyFat: null,
  segLeanRightArmKg: null,
  segLeanLeftArmKg: null,
  segLeanTrunkKg: null,
  segLeanRightLegKg: null,
  segLeanLeftLegKg: null,
  segLeanRightArmPct: null,
  segLeanLeftArmPct: null,
  segLeanTrunkPct: null,
  segLeanRightLegPct: null,
  segLeanLeftLegPct: null,
};

/** The 8 core required outputs, ordered for display. */
export function coreMetrics(t: InBodyTestRow): { label: string; value: string }[] {
  return [
    { label: "Weight", value: lbs(t.weightKg) },
    { label: "Total Body Water", value: lbs(t.totalBodyWaterKg) },
    { label: "Dry Lean Mass", value: lbs(t.dryLeanMassKg) },
    { label: "SMM (Skeletal Muscle Mass)", value: lbs(t.skeletalMuscleMassKg) },
    { label: "Body Fat Mass", value: lbs(t.bodyFatMassKg) },
    { label: "BMI", value: idx(t.bmi) },
    { label: "PBF (Percent Body Fat)", value: pct(t.percentBodyFat) },
  ];
}

/** Segmental Lean Analysis — 10 outputs (5 segments × mass + percent). */
export function segmentalMetrics(
  t: InBodyTestRow,
): { segment: string; mass: string; pct: string }[] {
  return [
    { segment: "Right Arm", mass: lbs(t.segLeanRightArmKg), pct: pct(t.segLeanRightArmPct) },
    { segment: "Left Arm", mass: lbs(t.segLeanLeftArmKg), pct: pct(t.segLeanLeftArmPct) },
    { segment: "Trunk", mass: lbs(t.segLeanTrunkKg), pct: pct(t.segLeanTrunkPct) },
    { segment: "Right Leg", mass: lbs(t.segLeanRightLegKg), pct: pct(t.segLeanRightLegPct) },
    { segment: "Left Leg", mass: lbs(t.segLeanLeftLegKg), pct: pct(t.segLeanLeftLegPct) },
  ];
}
