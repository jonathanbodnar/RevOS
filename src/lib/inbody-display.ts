/**
 * Shared display helpers for InBody metrics (used by both the admin InBody
 * page and the customer profile). Values are stored in metric units (kg) and
 * unitless indices; segmental lean is kg + percent.
 */

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

function kg(v: number | null): string {
  return v === null ? "—" : `${round(v)} kg`;
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

/** The 8 core required outputs, ordered for display. */
export function coreMetrics(t: InBodyTestRow): { label: string; value: string }[] {
  return [
    { label: "Weight", value: kg(t.weightKg) },
    { label: "Total Body Water", value: kg(t.totalBodyWaterKg) },
    { label: "Dry Lean Mass", value: kg(t.dryLeanMassKg) },
    { label: "SMM (Skeletal Muscle Mass)", value: kg(t.skeletalMuscleMassKg) },
    { label: "Body Fat Mass", value: kg(t.bodyFatMassKg) },
    { label: "BMI", value: idx(t.bmi) },
    { label: "PBF (Percent Body Fat)", value: pct(t.percentBodyFat) },
  ];
}

/** Segmental Lean Analysis — 10 outputs (5 segments × mass + percent). */
export function segmentalMetrics(
  t: InBodyTestRow,
): { segment: string; mass: string; pct: string }[] {
  return [
    { segment: "Right Arm", mass: kg(t.segLeanRightArmKg), pct: pct(t.segLeanRightArmPct) },
    { segment: "Left Arm", mass: kg(t.segLeanLeftArmKg), pct: pct(t.segLeanLeftArmPct) },
    { segment: "Trunk", mass: kg(t.segLeanTrunkKg), pct: pct(t.segLeanTrunkPct) },
    { segment: "Right Leg", mass: kg(t.segLeanRightLegKg), pct: pct(t.segLeanRightLegPct) },
    { segment: "Left Leg", mass: kg(t.segLeanLeftLegKg), pct: pct(t.segLeanLeftLegPct) },
  ];
}
