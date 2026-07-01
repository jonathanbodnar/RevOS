import { Prisma } from "@prisma/client";
import { prisma } from "./prisma";
import { normalizePhone } from "./phone";
import {
  EMPTY_METRICS,
  fetchInBodyResults,
  hasAnyMetric,
  inbodyCanFetch,
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
): Promise<{ id: string; clinicId: string | null }[]> {
  if (!phoneNormalized) return [];
  return prisma.$queryRaw<{ id: string; clinicId: string | null }[]>(Prisma.sql`
    SELECT id, "clinicId"
    FROM "Customer"
    WHERE right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 10) = ${phoneNormalized}
    LIMIT 5
  `);
}

function metricColumns(m: InBodyMetrics) {
  return {
    weightKg: m.weightKg,
    totalBodyWaterKg: m.totalBodyWaterKg,
    dryLeanMassKg: m.dryLeanMassKg,
    skeletalMuscleMassKg: m.skeletalMuscleMassKg,
    bodyFatMassKg: m.bodyFatMassKg,
    bmi: m.bmi,
    percentBodyFat: m.percentBodyFat,
    segLeanRightArmKg: m.segLeanRightArmKg,
    segLeanLeftArmKg: m.segLeanLeftArmKg,
    segLeanTrunkKg: m.segLeanTrunkKg,
    segLeanRightLegKg: m.segLeanRightLegKg,
    segLeanLeftLegKg: m.segLeanLeftLegKg,
    segLeanRightArmPct: m.segLeanRightArmPct,
    segLeanLeftArmPct: m.segLeanLeftArmPct,
    segLeanTrunkPct: m.segLeanTrunkPct,
    segLeanRightLegPct: m.segLeanRightLegPct,
    segLeanLeftLegPct: m.segLeanLeftLegPct,
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
  const testedAt = parseTestDatetimes(payload.TestDatetimes?.toString());
  const isTempData =
    payload.IsTempData === true ||
    String(payload.IsTempData ?? "").toLowerCase() === "true";

  const dedupeKey = [
    account ?? "",
    equipSerial ?? "",
    inbodyUserId ?? "",
    payload.TestDatetimes?.toString() ?? "",
  ].join(":");

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

  if (inbodyCanFetch()) {
    const fetched = await fetchInBodyResults({
      phone: rawPhone,
      userId: inbodyUserId,
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
  } else {
    // No fetch capability yet. Keep any metrics embedded in the webhook.
    metrics = webhookMetrics;
    fetchError =
      "InBody data fetch not configured (INBODY_DATA_FUNCTION unset); stored notification only.";
    resultStatus = hasAnyMetric(metrics) ? "fetched" : "pending";
  }

  const webhookJson = safeStringify(payload);

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
      rawJson,
      webhookJson,
      ...metricColumns(metrics),
    },
    update: {
      // Re-delivery: refresh metrics/pairing but don't clobber a manual mapping.
      account,
      equip,
      deviceType,
      testedAt,
      isTempData,
      resultStatus,
      fetchError,
      ...(rawJson ? { rawJson } : {}),
      webhookJson,
      ...metricColumns(metrics),
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
  let rawJson = test.rawJson;
  let fetchError: string | null = null;
  let resultStatus = test.resultStatus;

  if (inbodyCanFetch()) {
    const fetched = await fetchInBodyResults({
      phone: test.phone,
      userId: test.inbodyUserId,
      account: test.account,
    });
    if (fetched.error) {
      fetchError = fetched.error;
      resultStatus = "error";
    } else {
      metrics = fetched.metrics;
      rawJson = fetched.raw != null ? safeStringify(fetched.raw) : rawJson;
      resultStatus = hasAnyMetric(metrics) ? "fetched" : "matched_no_data";
    }
  } else {
    fetchError = "InBody data fetch not configured (INBODY_DATA_FUNCTION unset).";
  }

  return prisma.inBodyTest.update({
    where: { id: testId },
    data: {
      customerId,
      clinicId,
      matchStatus,
      resultStatus,
      fetchError,
      rawJson,
      ...(inbodyCanFetch() && !fetchError ? metricColumns(metrics) : {}),
    },
  });
}

function safeStringify(v: unknown): string | null {
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}
