/**
 * InBody / LookinBody Web API integration.
 *
 * Data flow:
 *   InBody device → LookinBody Web → webhook notification (POST to us) →
 *   we fetch the full body-composition result from the InBody Web API by
 *   phone (UserToken) + the test's datetimes → auto-pair to a RevOS customer
 *   by phone → store InBodyTest.
 *
 * Confirmed from InBody's authenticated API docs (apiusa.lookinbody.com/APIPage,
 * login required — LookinBody Web account credentials):
 *
 *   Base (US):  https://apiusa.lookinbody.com
 *   Auth headers on every call: `Account` (LookinBody Web account name) +
 *   `API-KEY` (generated in LookinBody Web → API Setup).
 *
 *   POST /user/test                                  → connection check
 *   POST /inbody/GetDateTimes      { usertoken }      → ["yyyyMMddHHmmss", ...]
 *   POST /inbody/GetDatetimesByID  { UserID }         → ["yyyyMMddHHmmss", ...]
 *   POST /inbody/GetInBodyData       { usertoken, datetimes }  → abbreviated fields (WT, PBF, BFM, ...)
 *   POST /inbody/GetInBodyDataByID   { UserID, Datetimes }     → abbreviated fields
 *   POST /inbody/GetFullInBodyData   { usertoken, datetimes }  → full-named fields (Weight, TBW(TotalBodyWater), ...)
 *   POST /inbody/GetFullInBodyDataByID { UserID, Datetimes }   → full-named fields
 *   POST /inbody/GetTodayMeasurements { Date }        → [{ UserID, UserToken, DateTimes }, ...] for that day
 *
 * `usertoken` (phone) is a GLOBAL parameter (searches the whole connected
 * network); `UserID` is LOCAL to this account's location.
 *
 * We call BOTH the abbreviated and full-name endpoints and merge them (full
 * names take priority) since InBody's docs only show a handful of fields in
 * each sample — this maximizes the chance we capture every required output
 * regardless of which endpoint actually returns it for a given device model.
 *
 * Never import this file from a client component — it uses the API key.
 */

const API_BASE = (process.env.INBODY_API_BASE || "https://apiusa.lookinbody.com").replace(/\/$/, "");
const API_KEY = process.env.INBODY_API_KEY || "";
/** LookinBody Web account name, e.g. "revosinbody2". */
const ACCOUNT = process.env.INBODY_ACCOUNT || "";

function hasCredentials(account?: string | null): boolean {
  return Boolean(API_KEY && (account || ACCOUNT).trim());
}

export function inbodyAccount(): string {
  return ACCOUNT.trim();
}

export function inbodyConfigured(account?: string | null): boolean {
  return hasCredentials(account);
}

export function inbodyCanFetch(account?: string | null): boolean {
  return hasCredentials(account);
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
  // "%" is load-bearing in InBody's full field names: "LeanMassofRightArm" (kg)
  // and "LeanMass(%)ofRightArm" (percent of ideal) would both collapse to
  // "leanmassofrightarm" if % were stripped, so the percent lookup would
  // silently return the kg value.
  return k.toLowerCase().replace(/%/g, "pct").replace(/[^a-z0-9]/g, "");
}

/** Case/format-insensitive numeric field lookup across many name variants. */
function deepEntries(obj: Record<string, unknown>, depth = 0): [string, unknown][] {
  const entries: [string, unknown][] = [];
  for (const [key, value] of Object.entries(obj)) {
    entries.push([key, value]);
    if (depth < 3 && value && typeof value === "object") {
      entries.push(...deepEntries(value as Record<string, unknown>, depth + 1));
    }
  }
  return entries;
}

function pickNum(obj: Record<string, unknown>, aliases: string[]): number | null {
  const wanted = new Set(aliases.map(normKey));
  for (const [key, val] of deepEntries(obj)) {
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

function firstNonNull(...vals: (number | null)[]): number | null {
  for (const v of vals) if (v !== null) return v;
  return null;
}

/**
 * Map an arbitrary InBody result object into our required-outputs shape.
 * Covers both the abbreviated field style (WT, PBF, BFM, SMM...) and the
 * "Full" endpoint's descriptive style (Weight, "TBW(TotalBodyWater)",
 * "BMI(BodyMassIndex)", "SMM(SkeletalMuscleMass)", ...), plus common
 * segmental-lean naming variants across InBody device/software versions.
 */
export function normalizeInBodyResult(raw: unknown): InBodyMetrics {
  if (!raw || typeof raw !== "object") return { ...EMPTY_METRICS };
  const obj = raw as Record<string, unknown>;
  return {
    weightKg: pickNum(obj, ["WT", "Weight", "weight_kg"]),
    totalBodyWaterKg: pickNum(obj, ["TBW", "TotalBodyWater", "TBWTotalBodyWater"]),
    dryLeanMassKg: pickNum(obj, ["DLM", "DryLeanMass", "DLM(DryLeanMass)", "DM"]),
    skeletalMuscleMassKg: pickNum(obj, ["SMM", "SkeletalMuscleMass", "SMMSkeletalMuscleMass"]),
    bodyFatMassKg: pickNum(obj, ["BFM", "BodyFatMass", "BFMBodyFatMass"]),
    bmi: pickNum(obj, ["BMI", "BodyMassIndex", "BMIBodyMassIndex"]),
    percentBodyFat: pickNum(obj, ["PBF", "PercentBodyFat", "BodyFatPercent", "PBF(PercentBodyFat)"]),

    // Segmental lean. The "LeanMassof…"/"LRA" spellings are what InBody
    // actually emits (verified against a real InBody380H payload); the older
    // aliases are kept for other device/firmware variants.
    segLeanRightArmKg: pickNum(obj, ["LeanMassofRightArm", "LRA", "LeanOfRightArm", "LeanRightArm", "RightArmLean", "LMRA", "SLM_RA", "LeanMassRightArm", "SLMRA"]),
    segLeanLeftArmKg: pickNum(obj, ["LeanMassofLeftArm", "LLA", "LeanOfLeftArm", "LeanLeftArm", "LeftArmLean", "LMLA", "SLM_LA", "LeanMassLeftArm", "SLMLA"]),
    segLeanTrunkKg: pickNum(obj, ["LeanMassofTrunk", "LT", "LeanOfTrunk", "LeanTrunk", "TrunkLean", "LMTR", "SLM_TR", "LeanMassTrunk", "SLMTR"]),
    segLeanRightLegKg: pickNum(obj, ["LeanMassofRightLeg", "LRL", "LeanOfRightLeg", "LeanRightLeg", "RightLegLean", "LMRL", "SLM_RL", "LeanMassRightLeg", "SLMRL"]),
    segLeanLeftLegKg: pickNum(obj, ["LeanMassofLeftLeg", "LLL", "LeanOfLeftLeg", "LeanLeftLeg", "LeftLegLean", "LMLL", "SLM_LL", "LeanMassLeftLeg", "SLMLL"]),

    // Percent OF IDEAL (normal-range midpoint), so values legitimately exceed
    // 100% — 98–135% is ordinary. Depends on normKey mapping "%" to "pct":
    // without that, these would resolve to the kg field above.
    segLeanRightArmPct: pickNum(obj, ["LeanMass(%)ofRightArm", "PILRA", "LeanPercentOfRightArm", "RightArmLeanPercent", "PLMRA", "SLP_RA", "PSLMRA"]),
    segLeanLeftArmPct: pickNum(obj, ["LeanMass(%)ofLeftArm", "PILLA", "LeanPercentOfLeftArm", "LeftArmLeanPercent", "PLMLA", "SLP_LA", "PSLMLA"]),
    segLeanTrunkPct: pickNum(obj, ["LeanMass(%)ofTrunk", "PILT", "LeanPercentOfTrunk", "TrunkLeanPercent", "PLMTR", "SLP_TR", "PSLMTR"]),
    segLeanRightLegPct: pickNum(obj, ["LeanMass(%)ofRightLeg", "PILRL", "LeanPercentOfRightLeg", "RightLegLeanPercent", "PLMRL", "SLP_RL", "PSLMRL"]),
    segLeanLeftLegPct: pickNum(obj, ["LeanMass(%)ofLeftLeg", "PILLL", "LeanPercentOfLeftLeg", "LeftLegLeanPercent", "PLMLL", "SLP_LL", "PSLMLL"]),
  };
}

/** Merge two normalized results, preferring `primary`'s non-null values. */
export function mergeMetrics(primary: InBodyMetrics, secondary: InBodyMetrics): InBodyMetrics {
  const out = { ...EMPTY_METRICS };
  for (const key of Object.keys(out) as (keyof InBodyMetrics)[]) {
    out[key] = firstNonNull(primary[key], secondary[key]);
  }
  return out;
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
  if (!Number.isFinite(dt.getTime())) return null;
  if (
    dt.getFullYear() !== y ||
    dt.getMonth() !== mo - 1 ||
    dt.getDate() !== d ||
    dt.getHours() !== h ||
    dt.getMinutes() !== mi ||
    dt.getSeconds() !== se
  ) {
    return null;
  }
  return dt;
}

/** Inverse of parseTestDatetimes — reconstructs the "yyyyMMddHHmmss" string. */
export function formatTestDatetimes(dt: Date): string {
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return (
    `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}` +
    `${pad(dt.getHours())}${pad(dt.getMinutes())}${pad(dt.getSeconds())}`
  );
}

function authHeaders(account?: string | null): Record<string, string> {
  return {
    Account: (account || ACCOUNT || "").trim(),
    "API-KEY": API_KEY,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

/**
 * Log what we called InBody *with* the first time a 401 shows up, then stay
 * quiet for an hour.
 *
 * InBody returns one generic 401 for three different causes — an IP that isn't
 * on their allowlist, a wrong key, and an exhausted daily quota — so the error
 * alone is undiagnosable, and this went unexplained for two months. Scans
 * arrive daily, so emitting the egress IP and a key fingerprint on failure
 * turns the next one into the answer without anyone having to go looking.
 */
let lastDiagnosticAt = 0;
const DIAGNOSTIC_INTERVAL_MS = 60 * 60 * 1000;

function reportUnauthorized(path: string, account?: string | null): void {
  const now = Date.now();
  if (now - lastDiagnosticAt < DIAGNOSTIC_INTERVAL_MS) return;
  lastDiagnosticAt = now;
  // Fire-and-forget so a diagnostic never delays or breaks ingestion.
  void detectEgressIp()
    .then((ip) => {
      // eslint-disable-next-line no-console
      console.error(
        `[inbody] 401 on ${path} — calling as account="${(account || ACCOUNT || "").trim() || "(unset)"}" ` +
          `key=${inbodyKeyFingerprint()} from egress IP ${ip ?? "(undetermined)"}. ` +
          `If that IP is not registered in the LookinBody portal (SETUP → server IP), that is the cause; ` +
          `otherwise compare the key fingerprint with the portal's.`,
      );
    })
    .catch(() => null);
}

async function post(
  path: string,
  body: unknown,
  account?: string | null,
): Promise<{ ok: boolean; status: number; json: unknown; text: string }> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: authHeaders(account),
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    // eslint-disable-next-line no-console
    console.error(`[inbody] POST ${path} → ${res.status}`, text.slice(0, 500));
    if (res.status === 401) reportUnauthorized(path, account);
  }
  return { ok: res.ok, status: res.status, json, text };
}

export type InBodyConnectionResult = {
  ok: boolean;
  status: number;
  body: string;
  /** Public IP this server egresses from — must be allow-listed by InBody. */
  egressIp?: string | null;
  /** Non-secret fingerprint of the key in use, to compare with the portal. */
  keyFingerprint?: string;
  account?: string;
};

/**
 * Identify the key without disclosing it: length plus first/last 4 characters
 * is enough to tell "the key changed" or "the key has a stray character" apart
 * from "the key is right", which is the whole diagnostic question.
 */
export function inbodyKeyFingerprint(): string {
  if (!API_KEY) return "(unset)";
  const len = API_KEY.length;
  if (len <= 8) return `len=${len}`;
  return `len=${len} ${API_KEY.slice(0, 4)}…${API_KEY.slice(-4)}`;
}

/**
 * Best-effort public egress IP of this server.
 *
 * InBody allow-lists caller IPs and returns the same generic 401 for a
 * non-listed IP as for a bad key or an exhausted daily quota — so without this,
 * a misconfigured allowlist is indistinguishable from a wrong credential and
 * can go unnoticed for weeks. Never throws; a null just means "couldn't tell".
 */
export async function detectEgressIp(): Promise<string | null> {
  try {
    const res = await fetch("https://api.ipify.org?format=json", {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { ip?: string };
    return json.ip ?? null;
  } catch {
    return null;
  }
}

/** POST /user/test — verifies Account + API-KEY credentials. */
export async function inbodyConnectionTest(account?: string | null): Promise<InBodyConnectionResult> {
  const diagnostics = {
    keyFingerprint: inbodyKeyFingerprint(),
    account: (account || ACCOUNT || "").trim() || "(unset)",
  };
  if (!inbodyConfigured(account)) {
    return {
      ok: false,
      status: 503,
      body: "INBODY_API_KEY and INBODY_ACCOUNT must both be configured.",
      ...diagnostics,
    };
  }
  try {
    const [r, egressIp] = await Promise.all([
      post("/user/test", {}, account),
      detectEgressIp(),
    ]);
    return { ok: r.ok, status: r.status, body: r.text.slice(0, 2000), egressIp, ...diagnostics };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: err instanceof Error ? err.message : String(err),
      egressIp: await detectEgressIp(),
      ...diagnostics,
    };
  }
}

/** POST /inbody/GetDateTimes or GetDatetimesByID — list all known test datetimes for a member. */
export async function inbodyGetDateTimes(opts: {
  phone?: string | null;
  userId?: string | null;
  account?: string | null;
}): Promise<{ datetimes: string[]; error: string | null }> {
  if (!inbodyConfigured(opts.account)) {
    return { datetimes: [], error: "INBODY_API_KEY and INBODY_ACCOUNT must both be configured" };
  }
  try {
    const r = opts.phone
      ? await post("/inbody/GetDateTimes", { usertoken: opts.phone }, opts.account)
      : await post("/inbody/GetDatetimesByID", { UserID: opts.userId }, opts.account);
    if (!r.ok) return { datetimes: [], error: `InBody ${r.status}: ${r.text.slice(0, 300)}` };
    return { datetimes: extractDateTimes(r.json), error: null };
  } catch (err) {
    return { datetimes: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** POST /inbody/GetTodayMeasurements — list all tests recorded on a given date across the account. */
export async function inbodyGetTodayMeasurements(
  date: string,
  account?: string | null,
): Promise<{ records: { UserID: string; UserToken: string; DateTimes: string }[]; error: string | null }> {
  if (!inbodyConfigured(account)) {
    return { records: [], error: "INBODY_API_KEY and INBODY_ACCOUNT must both be configured" };
  }
  try {
    const r = await post("/inbody/GetTodayMeasurements", { Date: date }, account);
    if (!r.ok) return { records: [], error: `InBody ${r.status}: ${r.text.slice(0, 300)}` };
    return { records: parseTodayMeasurementRecords(r.json), error: null };
  } catch (err) {
    return { records: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export type InBodyFetchResult = {
  metrics: InBodyMetrics;
  raw: unknown;
  error: string | null;
};

/**
 * Fetch a specific body-composition result identified by phone (or UserID)
 * PLUS the exact test datetimes (as delivered in the webhook's
 * `TestDatetimes` field, format yyyyMMddHHmmss). Calls both the abbreviated
 * and full-name endpoints and merges the results for maximum field coverage.
 */
export async function fetchInBodyResults(opts: {
  phone?: string | null;
  userId?: string | null;
  datetimes: string;
  account?: string | null;
}): Promise<InBodyFetchResult> {
  if (!inbodyConfigured(opts.account)) {
    return {
      metrics: { ...EMPTY_METRICS },
      raw: null,
      error: "INBODY_API_KEY and INBODY_ACCOUNT must both be configured",
    };
  }
  if (!opts.datetimes) {
    return { metrics: { ...EMPTY_METRICS }, raw: null, error: "Missing test datetimes for InBody lookup" };
  }

  const byPhone = Boolean(opts.phone);
  const fullPath = byPhone ? "/inbody/GetFullInBodyData" : "/inbody/GetFullInBodyDataByID";
  const abbrevPath = byPhone ? "/inbody/GetInBodyData" : "/inbody/GetInBodyDataByID";
  const fullBody = byPhone
    ? { usertoken: opts.phone, datetimes: opts.datetimes }
    : { UserID: opts.userId, Datetimes: opts.datetimes };
  const abbrevBody = byPhone
    ? { usertoken: opts.phone, datetimes: opts.datetimes }
    : { UserID: opts.userId, Datetimes: opts.datetimes };

  try {
    const [full, abbrev] = await Promise.all([
      post(fullPath, fullBody, opts.account),
      post(abbrevPath, abbrevBody, opts.account),
    ]);

    if (!full.ok && !abbrev.ok) {
      const msg = `InBody ${full.status || abbrev.status}: ${(full.text || abbrev.text).slice(0, 300)}`;
      return { metrics: { ...EMPTY_METRICS }, raw: null, error: msg };
    }

    const fullRecord = selectResultRecord(full.json, opts.datetimes);
    const abbrevRecord = selectResultRecord(abbrev.json, opts.datetimes);

    const fullMetrics = normalizeInBodyResult(fullRecord);
    const abbrevMetrics = normalizeInBodyResult(abbrevRecord);
    const merged = mergeMetrics(fullMetrics, abbrevMetrics);

    return {
      metrics: merged,
      raw: { full: full.ok ? fullRecord : { error: full.text }, abbrev: abbrev.ok ? abbrevRecord : { error: abbrev.text } },
      error: null,
    };
  } catch (err) {
    return {
      metrics: { ...EMPTY_METRICS },
      raw: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function findArrayPayload(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const obj = value as Record<string, unknown>;
  for (const key of ["data", "Data", "result", "Result", "results", "Results", "items", "Items"]) {
    if (Array.isArray(obj[key])) return obj[key] as unknown[];
  }
  return [];
}

function pickString(obj: Record<string, unknown>, aliases: string[]): string {
  const wanted = new Set(aliases.map(normKey));
  for (const [key, value] of Object.entries(obj)) {
    if (!wanted.has(normKey(key)) || value === null || value === undefined) continue;
    return String(value).trim();
  }
  return "";
}

function extractDateTimes(value: unknown): string[] {
  return findArrayPayload(value)
    .map((item) => {
      if (typeof item === "string" || typeof item === "number") return String(item).trim();
      if (!item || typeof item !== "object") return "";
      return pickString(item as Record<string, unknown>, ["DateTimes", "Datetimes", "TestDatetimes"]);
    })
    .filter(Boolean);
}

/** Normalize GetTodayMeasurements response wrappers and field-name casing. */
export function parseTodayMeasurementRecords(
  value: unknown,
): { UserID: string; UserToken: string; DateTimes: string }[] {
  return findArrayPayload(value)
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    .map((item) => ({
      UserID: pickString(item, ["UserID", "ID"]),
      UserToken: pickString(item, ["UserToken", "TelHP", "Phone"]),
      DateTimes: pickString(item, ["DateTimes", "Datetimes", "TestDatetimes"]),
    }))
    .filter((item) => Boolean(item.DateTimes));
}

function selectResultRecord(value: unknown, datetimes: string): unknown {
  const records = findArrayPayload(value);
  if (records.length === 0) return value;
  const wanted = datetimes.replace(/\D/g, "");
  const exact = records.find((item) => {
    if (!item || typeof item !== "object") return false;
    const actual = pickString(item as Record<string, unknown>, [
      "DateTimes",
      "Datetimes",
      "TestDatetimes",
    ]).replace(/\D/g, "");
    return Boolean(actual && actual === wanted);
  });
  return exact ?? records[0];
}
