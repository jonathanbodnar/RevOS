/**
 * InBody / LookinBody Web API integration.
 *
 * Data flow:
 *   InBody device → LookinBody Web → webhook notification (POST to us) →
 *   we fetch the full body-composition result from the InBody Web API by phone
 *   (UserToken) → auto-pair to a RevOS customer by phone → store InBodyTest.
 *
 * The webhook itself is only a NOTIFICATION (identifiers + phone, no metrics).
 * The metrics come from the InBody Web API which authenticates with two HTTP
 * headers: `Account` (the LookinBody Web account, e.g. "revosinbody2") and
 * `API-KEY` (generated in the LookinBody Web API setup page).
 *
 *   Base (US):  https://apiusa.lookinbody.com
 *   Test:       POST /user/test            → { "success" }
 *   Data:       POST /<data-function>      → [ { ...metrics } ]
 *               searched by UserToken (phone, global) or UserID (local).
 *
 * The exact data-function path + response field names live in the developer
 * docs InBody hands over after the API application is approved. Rather than
 * hard-code a guess that would 404, the function path is configured via
 * INBODY_DATA_FUNCTION and the response is run through a tolerant normalizer
 * (`normalizeInBodyResult`) that matches many field-name variants and always
 * preserves the raw payload. Once the real field names are confirmed, only the
 * alias lists below need touching.
 *
 * Never import this file from a client component — it uses the API key.
 */

const API_BASE = (process.env.INBODY_API_BASE || "https://apiusa.lookinbody.com").replace(/\/$/, "");
const API_KEY = process.env.INBODY_API_KEY || "";
/** LookinBody Web account name, e.g. "revosinbody2". */
const ACCOUNT = process.env.INBODY_ACCOUNT || "";
/**
 * Path (relative to API_BASE) of the function that returns body-composition
 * results. Left unset until the approved developer docs confirm it, e.g.
 * "/InBodyData" or "/UserData". When empty we skip the fetch and keep the
 * notification (results backfill later via re-fetch).
 */
const DATA_FUNCTION = (process.env.INBODY_DATA_FUNCTION || "").trim();

export function inbodyConfigured(): boolean {
  return Boolean(API_KEY);
}

export function inbodyCanFetch(): boolean {
  return Boolean(API_KEY && DATA_FUNCTION);
}

export type InBodyMetrics = {
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

export const EMPTY_METRICS: InBodyMetrics = {
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

function normKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Case/format-insensitive numeric field lookup across many name variants. */
function pickNum(obj: Record<string, unknown>, aliases: string[]): number | null {
  const wanted = new Set(aliases.map(normKey));
  for (const [key, val] of Object.entries(obj)) {
    if (!wanted.has(normKey(key))) continue;
    const n = toNum(val);
    if (n !== null) return n;
  }
  return null;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * Map an arbitrary InBody result object into our required-outputs shape. The
 * same normalizer is used for both API responses and (defensively) webhook
 * payloads in case a location is configured to POST full data.
 */
export function normalizeInBodyResult(raw: unknown): InBodyMetrics {
  if (!raw || typeof raw !== "object") return { ...EMPTY_METRICS };
  const obj = raw as Record<string, unknown>;
  return {
    weightKg: pickNum(obj, ["WT", "Weight", "weight_kg"]),
    totalBodyWaterKg: pickNum(obj, ["TBW", "TotalBodyWater"]),
    dryLeanMassKg: pickNum(obj, ["DLM", "DryLeanMass"]),
    skeletalMuscleMassKg: pickNum(obj, ["SMM", "SkeletalMuscleMass"]),
    bodyFatMassKg: pickNum(obj, ["BFM", "BodyFatMass"]),
    bmi: pickNum(obj, ["BMI", "BodyMassIndex"]),
    percentBodyFat: pickNum(obj, ["PBF", "PercentBodyFat", "BodyFatPercent"]),

    segLeanRightArmKg: pickNum(obj, ["LeanOfRightArm", "LeanRightArm", "RightArmLean", "LMRA", "SLM_RA", "LeanMassRightArm"]),
    segLeanLeftArmKg: pickNum(obj, ["LeanOfLeftArm", "LeanLeftArm", "LeftArmLean", "LMLA", "SLM_LA", "LeanMassLeftArm"]),
    segLeanTrunkKg: pickNum(obj, ["LeanOfTrunk", "LeanTrunk", "TrunkLean", "LMTR", "SLM_TR", "LeanMassTrunk"]),
    segLeanRightLegKg: pickNum(obj, ["LeanOfRightLeg", "LeanRightLeg", "RightLegLean", "LMRL", "SLM_RL", "LeanMassRightLeg"]),
    segLeanLeftLegKg: pickNum(obj, ["LeanOfLeftLeg", "LeanLeftLeg", "LeftLegLean", "LMLL", "SLM_LL", "LeanMassLeftLeg"]),

    segLeanRightArmPct: pickNum(obj, ["LeanPercentOfRightArm", "RightArmLeanPercent", "PLMRA", "SLP_RA"]),
    segLeanLeftArmPct: pickNum(obj, ["LeanPercentOfLeftArm", "LeftArmLeanPercent", "PLMLA", "SLP_LA"]),
    segLeanTrunkPct: pickNum(obj, ["LeanPercentOfTrunk", "TrunkLeanPercent", "PLMTR", "SLP_TR"]),
    segLeanRightLegPct: pickNum(obj, ["LeanPercentOfRightLeg", "RightLegLeanPercent", "PLMRL", "SLP_RL"]),
    segLeanLeftLegPct: pickNum(obj, ["LeanPercentOfLeftLeg", "LeftLegLeanPercent", "PLMLL", "SLP_LL"]),
  };
}

export function hasAnyMetric(m: InBodyMetrics): boolean {
  return Object.values(m).some((v) => v !== null);
}

/** Parse an InBody "yyyyMMddHHmmss" (or shorter) timestamp into a Date. */
export function parseTestDatetimes(input: string | null | undefined): Date | null {
  if (!input) return null;
  const s = String(input).replace(/\D+/g, "");
  if (s.length < 8) return null;
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  const h = Number(s.slice(8, 10) || "0");
  const mi = Number(s.slice(10, 12) || "0");
  const se = Number(s.slice(12, 14) || "0");
  const dt = new Date(y, mo - 1, d, h, mi, se);
  return Number.isFinite(dt.getTime()) ? dt : null;
}

function authHeaders(account?: string | null): Record<string, string> {
  return {
    Account: (account || ACCOUNT || "").trim(),
    "API-KEY": API_KEY,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

export type InBodyConnectionResult = {
  ok: boolean;
  status: number;
  body: string;
};

/** POST /user/test — verifies Account + API-KEY credentials. */
export async function inbodyConnectionTest(account?: string | null): Promise<InBodyConnectionResult> {
  if (!inbodyConfigured()) {
    return { ok: false, status: 503, body: "INBODY_API_KEY is not configured." };
  }
  try {
    const res = await fetch(`${API_BASE}/user/test`, {
      method: "POST",
      headers: authHeaders(account),
      body: "{}",
      cache: "no-store",
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body: body.slice(0, 2000) };
  } catch (err) {
    return { ok: false, status: 0, body: err instanceof Error ? err.message : String(err) };
  }
}

export type InBodyFetchResult = {
  metrics: InBodyMetrics;
  raw: unknown;
  error: string | null;
};

/**
 * Fetch the most recent body-composition result for a phone (UserToken) or
 * UserID. Returns normalized metrics + the raw payload. When the data-function
 * path is not configured, resolves with an explanatory error and empty metrics
 * so callers can persist the notification and backfill later.
 */
export async function fetchInBodyResults(opts: {
  phone?: string | null;
  userId?: string | null;
  account?: string | null;
}): Promise<InBodyFetchResult> {
  if (!inbodyConfigured()) {
    return { metrics: { ...EMPTY_METRICS }, raw: null, error: "INBODY_API_KEY not configured" };
  }
  if (!DATA_FUNCTION) {
    return {
      metrics: { ...EMPTY_METRICS },
      raw: null,
      error:
        "INBODY_DATA_FUNCTION not configured — awaiting InBody developer docs for the data-fetch endpoint.",
    };
  }
  const path = DATA_FUNCTION.startsWith("/") ? DATA_FUNCTION : `/${DATA_FUNCTION}`;
  // UserToken (phone) is the global search key; UserID is location-local.
  const body: Record<string, string> = {};
  if (opts.phone) body.UserToken = opts.phone;
  if (opts.userId) body.UserID = opts.userId;
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: authHeaders(opts.account),
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok) {
      // eslint-disable-next-line no-console
      console.error(`[inbody] POST ${path} → ${res.status}`, text.slice(0, 500));
      return { metrics: { ...EMPTY_METRICS }, raw: null, error: `InBody ${res.status}: ${text.slice(0, 300)}` };
    }
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      return { metrics: { ...EMPTY_METRICS }, raw: text, error: "InBody returned non-JSON body" };
    }
    // Results may be an array (most recent first) or a single object.
    const record = Array.isArray(json) ? json[0] : json;
    return { metrics: normalizeInBodyResult(record), raw: json, error: null };
  } catch (err) {
    return {
      metrics: { ...EMPTY_METRICS },
      raw: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
