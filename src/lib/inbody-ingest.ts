import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { normalizePhone } from "./phone";
import { encryptField, decryptField, isDecryptFailure } from "./encryption";
import {
  EMPTY_METRICS,
  fetchInBodyResults,
  formatTestDatetimes,
  hasAnyMetric,
  inbodyAccount,
  inbodyCanFetch,
  inbodyGetTodayMeasurements,
  normalizeInBodyResult,
  parseTestDatetimes,
  type InBodyMetrics,
} from "./inbody";

export type InBodyWebhookPayload = {
  EquipSerial?: string;
  TelHP?: string;
  UserID?: string;
  TestDatetimes?: string;
  Account?: string;
  Equip?: string;
  Type?: string;
  IsTempData?: string | boolean;
  [key: string]: unknown;
};

/**
 * Find the RevOS customer(s) whose phone matches the given normalized (last-10)
 * number. Normalization is done in-DB so we match regardless of stored format.
 */
async function findCustomersByPhone(
  phoneNormalized: string,
): Promise<{ id: string; clinicId: string }[]> {
  // Auto-link only a complete US national number. A short extension or other
  // partial value must never be enough to attach medical data to a customer.
  if (phoneNormalized.length !== 10) return [];
  return prisma.$queryRaw<{ id: string; clinicId: string }[]>(Prisma.sql`
    SELECT id, "clinicId"
    FROM "Customer"
    WHERE "clinicId" IS NOT NULL
      AND right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = ${phoneNormalized}
    LIMIT 5
  `);
}

// Reject physiologically-impossible values (negative, zero, or absurd) rather
// than storing garbage that would skew charts and KPIs. Out-of-range → null.
function inRange(v: number | null, min: number, max: number): number | null {
  return v != null && Number.isFinite(v) && v >= min && v <= max ? v : null;
}
const KG = (v: number | null) => inRange(v, 0.1, 500);
// Body-fat % is a true 0–100 proportion.
const PCT = (v: number | null) => inRange(v, 0, 100);
// Segmental-lean is "percent of ideal" — muscular patients routinely exceed
// 100% (110–130% is normal), so use a generous upper bound and only reject
// clearly-impossible values.
const PSLM = (v: number | null) => inRange(v, 0, 500);

export function metricColumns(m: InBodyMetrics) {
  return {
    weightKg: KG(m.weightKg),
    totalBodyWaterKg: KG(m.totalBodyWaterKg),
    dryLeanMassKg: KG(m.dryLeanMassKg),
    skeletalMuscleMassKg: KG(m.skeletalMuscleMassKg),
    bodyFatMassKg: KG(m.bodyFatMassKg),
    bmi: inRange(m.bmi, 5, 100),
    percentBodyFat: PCT(m.percentBodyFat),
    segLeanRightArmKg: KG(m.segLeanRightArmKg),
    segLeanLeftArmKg: KG(m.segLeanLeftArmKg),
    segLeanTrunkKg: KG(m.segLeanTrunkKg),
    segLeanRightLegKg: KG(m.segLeanRightLegKg),
    segLeanLeftLegKg: KG(m.segLeanLeftLegKg),
    segLeanRightArmPct: PSLM(m.segLeanRightArmPct),
    segLeanLeftArmPct: PSLM(m.segLeanLeftArmPct),
    segLeanTrunkPct: PSLM(m.segLeanTrunkPct),
    segLeanRightLegPct: PSLM(m.segLeanRightLegPct),
    segLeanLeftLegPct: PSLM(m.segLeanLeftLegPct),
  };
}

/**
 * Ingest a LookinBody webhook notification: dedupe, auto-pair to a customer by
 * phone, fetch the full result set from the InBody API, and upsert an
 * InBodyTest row. Idempotent on the dedupe key so repeated deliveries are safe.
 */
export async function ingestInBodyNotification(payload: InBodyWebhookPayload) {
  const account = payload.Account?.toString().trim() || null;
  const equipSerial = payload.EquipSerial?.toString().trim() || null;
  const equip = payload.Equip?.toString().trim() || null;
  const deviceType = payload.Type?.toString().trim() || null;
  const inbodyUserId = payload.UserID?.toString().trim() || null;
  const rawPhone = payload.TelHP?.toString().trim() || null;
  const phoneNormalized = normalizePhone(rawPhone);
  const rawDatetimes = payload.TestDatetimes?.toString().trim() || "";
  const testedAt = parseTestDatetimes(rawDatetimes);
  const isTempData =
    payload.IsTempData === true ||
    String(payload.IsTempData ?? "").toLowerCase() === "true";

  const dedupeKey = [account ?? "", equipSerial ?? "", inbodyUserId ?? "", rawDatetimes].join(":");
  const existing = await prisma.inBodyTest.findUnique({ where: { dedupeKey } });

  // ── Auto-pair by phone ──
  let customerId: string | null = null;
  let clinicId: string | null = null;
  let matchStatus = "unmatched";
  if (phoneNormalized) {
    const matches = await findCustomersByPhone(phoneNormalized);
    if (matches.length === 1) {
      customerId = matches[0].id;
      clinicId = matches[0].clinicId;
      matchStatus = "auto";
    } else if (matches.length > 1) {
      matchStatus = "ambiguous";
    }
  }

  // ── Fetch the full result set (skipped gracefully if unconfigured) ──
  let metrics: InBodyMetrics = { ...EMPTY_METRICS };
  let rawJson: string | null = null;
  let fetchError: string | null = null;
  let resultStatus = "pending";

  // Defensive: some locations may POST full metrics in the webhook itself.
  const webhookMetrics = normalizeInBodyResult(payload);

  if (inbodyCanFetch(account) && rawDatetimes && (rawPhone || inbodyUserId)) {
    const fetched = await fetchInBodyResults({
      phone: rawPhone,
      userId: inbodyUserId,
      datetimes: rawDatetimes,
      account,
    });
    if (fetched.error) {
      fetchError = fetched.error;
      metrics = hasAnyMetric(webhookMetrics) ? webhookMetrics : { ...EMPTY_METRICS };
      resultStatus = hasAnyMetric(metrics) ? "fetched" : "error";
      if (fetched.raw != null) rawJson = safeStringify(fetched.raw);
    } else {
      metrics = hasAnyMetric(fetched.metrics) ? fetched.metrics : webhookMetrics;
      rawJson = fetched.raw != null ? safeStringify(fetched.raw) : null;
      resultStatus = hasAnyMetric(metrics) ? "fetched" : "matched_no_data";
    }
  } else if (!inbodyCanFetch(account)) {
    metrics = webhookMetrics;
    fetchError = "INBODY_API_KEY and INBODY_ACCOUNT must both be configured; stored notification only.";
    resultStatus = hasAnyMetric(metrics) ? "fetched" : "pending";
  } else {
    metrics = webhookMetrics;
    fetchError = "Missing phone/UserID or test datetimes; cannot fetch InBody result.";
    resultStatus = hasAnyMetric(metrics) ? "fetched" : "pending";
  }

  const webhookJson = safeStringify(payload);

  const newMetricsAvailable = hasAnyMetric(metrics);
  const existingMetricsAvailable = existing ? hasStoredMetric(existing) : false;
  const preservedResultStatus =
    existingMetricsAvailable && !newMetricsAvailable ? "fetched" : resultStatus;
  const preserveManualMapping = existing?.matchStatus === "manual";

  const test = await prisma.inBodyTest.upsert({
    where: { dedupeKey },
    create: {
      dedupeKey,
      account,
      equipSerial,
      equip,
      deviceType,
      inbodyUserId,
      phone: rawPhone,
      phoneNormalized,
      testedAt,
      isTempData,
      clinicId,
      customerId,
      matchStatus,
      resultStatus,
      fetchError,
      // Raw payloads contain PHI (phone) — encrypt at rest.
      rawJson: encryptField(rawJson),
      webhookJson: encryptField(webhookJson),
      ...metricColumns(metrics),
    },
    update: {
      // Re-delivery: refresh metrics/pairing but don't clobber a manual mapping.
      account,
      equipSerial,
      equip,
      deviceType,
      inbodyUserId,
      phone: rawPhone,
      phoneNormalized,
      testedAt,
      isTempData,
      resultStatus: preservedResultStatus,
      fetchError,
      ...(rawJson ? { rawJson: encryptField(rawJson) } : {}),
      webhookJson: encryptField(webhookJson),
      ...(newMetricsAvailable ? metricColumns(metrics) : {}),
      ...(!preserveManualMapping && phoneNormalized
        ? { customerId, clinicId, matchStatus }
        : {}),
    },
  });

  return test;
}

/** Re-run auto-pairing + data fetch for an existing test (admin action). */
export async function refetchInBodyTest(testId: string) {
  const test = await prisma.inBodyTest.findUnique({ where: { id: testId } });
  if (!test) return null;

  // Re-attempt auto-pair only if still unmatched (never override a manual map).
  let customerId = test.customerId;
  let clinicId = test.clinicId;
  let matchStatus = test.matchStatus;
  if (!customerId && test.phoneNormalized) {
    const matches = await findCustomersByPhone(test.phoneNormalized);
    if (matches.length === 1) {
      customerId = matches[0].id;
      clinicId = matches[0].clinicId;
      matchStatus = "auto";
    } else if (matches.length > 1) {
      matchStatus = "ambiguous";
    }
  }

  let metrics: InBodyMetrics = { ...EMPTY_METRICS };
  // Decrypt the stored blob so downstream logic works on plaintext; it's
  // re-encrypted at the write below.
  // If the stored blob can't be decrypted, treat it as absent rather than
  // carrying the placeholder into the re-encrypt below — that would overwrite
  // recoverable ciphertext with the literal "[unable to decrypt]". A fresh
  // fetch may replace it; otherwise `preserveRawJson` keeps the original.
  const rawJsonUnreadable = isDecryptFailure(decryptField(test.rawJson));
  let rawJson = rawJsonUnreadable ? null : decryptField(test.rawJson);
  let fetchError: string | null = null;
  let resultStatus = test.resultStatus;

  const datetimes = originalTestDatetimes(test);
  const storedMetricsAvailable = hasStoredMetric(test);

  if (!inbodyCanFetch(test.account)) {
    fetchError = "INBODY_API_KEY and INBODY_ACCOUNT must both be configured.";
  } else if (!datetimes || (!test.phone && !test.inbodyUserId)) {
    fetchError = "Missing phone/UserID or test datetimes; cannot fetch InBody result.";
  } else {
    const fetched = await fetchInBodyResults({
      phone: test.phone,
      userId: test.inbodyUserId,
      datetimes,
      account: test.account,
    });
    if (fetched.error) {
      fetchError = fetched.error;
      resultStatus = storedMetricsAvailable ? "fetched" : "error";
    } else {
      metrics = fetched.metrics;
      rawJson = fetched.raw != null ? safeStringify(fetched.raw) : rawJson;
      resultStatus =
        hasAnyMetric(metrics) || storedMetricsAvailable ? "fetched" : "matched_no_data";
    }
  }

  return prisma.inBodyTest.update({
    where: { id: testId },
    data: {
      customerId,
      clinicId,
      matchStatus,
      resultStatus,
      fetchError,
      // Don't clobber an unreadable-but-intact blob with null/placeholder;
      // only write when we actually have plaintext to store.
      ...(rawJsonUnreadable && rawJson == null
        ? {}
        : { rawJson: encryptField(rawJson) }),
      ...(hasAnyMetric(metrics) ? metricColumns(metrics) : {}),
    },
  });
}

/**
 * Pull every InBody test recorded on a given date (default: today, UTC)
 * directly from the InBody Web API — a manual "sync now" path independent of
 * webhook delivery, e.g. for backfilling existing live data. Returns a
 * summary of how many records were found/ingested/errored.
 */
export async function syncInBodyMeasurementsForDate(
  date?: string,
): Promise<{ found: number; ingested: number; errors: string[] }> {
  const targetDate = date || new Date().toISOString().slice(0, 10);
  const { records, error } = await inbodyGetTodayMeasurements(targetDate);
  if (error) return { found: 0, ingested: 0, errors: [error] };

  const errors: string[] = [];
  let ingested = 0;
  for (const rec of records) {
    if (!rec.DateTimes) continue;
    try {
      await ingestInBodyNotification({
        Account: inbodyAccount() || undefined,
        UserID: rec.UserID,
        TelHP: rec.UserToken,
        TestDatetimes: rec.DateTimes,
      });
      ingested++;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { found: records.length, ingested, errors };
}

/** Re-fetch historical tests that still lack stored measurements. */
export async function backfillInBodyTests(
  limit = 200,
): Promise<{ scanned: number; fetched: number; mapped: number; errors: string[] }> {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit) || 200, 500));
  const tests = await prisma.inBodyTest.findMany({
    where: { resultStatus: { not: "fetched" } },
    orderBy: [{ testedAt: "desc" }, { createdAt: "desc" }],
    select: { id: true },
    take: safeLimit,
  });

  let fetched = 0;
  let mapped = 0;
  const errors: string[] = [];
  for (const test of tests) {
    try {
      const updated = await refetchInBodyTest(test.id);
      if (!updated) continue;
      if (updated.resultStatus === "fetched") fetched++;
      if (updated.customerId) mapped++;
      if (updated.fetchError && updated.resultStatus !== "fetched") {
        errors.push(`${test.id}: ${updated.fetchError}`);
      }
    } catch (err) {
      errors.push(`${test.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { scanned: tests.length, fetched, mapped, errors };
}

function hasStoredMetric(test: {
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
}): boolean {
  return Object.values(metricColumns(test)).some((value) => value !== null);
}

function originalTestDatetimes(test: {
  webhookJson: string | null;
  dedupeKey: string;
  testedAt: Date | null;
}): string | null {
  if (test.webhookJson) {
    try {
      // Stored encrypted; decryptField passes plaintext through unchanged.
      const payload = JSON.parse(
        decryptField(test.webhookJson) ?? "",
      ) as Record<string, unknown>;
      const raw = payload.TestDatetimes;
      if (typeof raw === "string" && raw.trim()) return raw.trim();
    } catch {
      // Fall through to the stable dedupe key / parsed Date fallback.
    }
  }
  const dedupePart = test.dedupeKey.split(":").at(-1) || "";
  if (/^\d{8,14}$/.test(dedupePart)) return dedupePart;
  return test.testedAt ? formatTestDatetimes(test.testedAt) : null;
}

function safeStringify(v: unknown): string | null {
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}
