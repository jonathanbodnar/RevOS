import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { ingestInBodyNotification, type InBodyWebhookPayload } from "@/lib/inbody-ingest";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * LookinBody Web webhook receiver. Fired when an InBody test completes.
 *
 * Sample payload (identifiers only — metrics are fetched from the API):
 *   { "EquipSerial":"CC71700163", "TelHP":"01012344733", "UserID":"1234",
 *     "TestDatetimes":"20190811120103", "Account":"revosinbody2",
 *     "Equip":"InBody770", "Type":"InBody", "IsTempData":"false" }
 *
 * Verification: LookinBody lets you attach custom Key/Value security headers in
 * the webhook setup. If INBODY_WEBHOOK_SECRET is set, at least one incoming
 * header value must equal it. If INBODY_ACCOUNT is set, the payload's Account
 * must match. Must respond 200 with a success body for LookinBody to save the
 * webhook during its "Sent Test" step.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.INBODY_WEBHOOK_SECRET;
  // Fail closed: without a configured secret, reject rather than ingest
  // unauthenticated PHI.
  if (!secret) {
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }
  {
    const expected = Buffer.from(secret);
    let ok = false;
    req.headers.forEach((value) => {
      // Constant-time comparison so header probing can't brute-force the
      // secret one byte at a time.
      const candidate = Buffer.from(value);
      if (
        candidate.length === expected.length &&
        timingSafeEqual(candidate, expected)
      ) {
        ok = true;
      }
    });
    if (!ok) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  const payload = await parseBody(req);
  if (!payload) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const expectedAccount = process.env.INBODY_ACCOUNT;
  if (
    expectedAccount &&
    payload.Account &&
    String(payload.Account).trim().toLowerCase() !== expectedAccount.trim().toLowerCase()
  ) {
    return NextResponse.json({ error: "Unknown account" }, { status: 401 });
  }

  // Minimal validation: a test must carry enough to build a stable dedupe key
  // (a datetime plus an equipment serial or user id). Reject clearly-malformed
  // notifications with a 200 so LookinBody stops retrying, but don't ingest.
  const hasDatetimes = !!String(payload.TestDatetimes ?? "").trim();
  const hasIdentifier =
    !!String(payload.EquipSerial ?? "").trim() ||
    !!String(payload.UserID ?? "").trim();
  if (!hasDatetimes || !hasIdentifier) {
    return NextResponse.json({ success: false, reason: "missing identifiers" });
  }

  try {
    const test = await ingestInBodyNotification(payload);
    // eslint-disable-next-line no-console
    // No PHI in logs — the customer link is enough to trace, phone is not.
    console.info(
      `[inbody] ingested test ${test.id} customer=${test.customerId ?? "unmatched"} match=${test.matchStatus} result=${test.resultStatus}`,
    );
    return NextResponse.json({ success: true, id: test.id, matched: Boolean(test.customerId) });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[inbody] webhook ingest failed", err);
    // Webhooks return 200 even on internal error so the sender stops retrying
    // (idempotency is on the dedupe key). See AGENTS.md webhook convention.
    return NextResponse.json({ success: false, error: "ingest failed" });
  }
}

async function parseBody(req: NextRequest): Promise<InBodyWebhookPayload | null> {
  const ct = req.headers.get("content-type") || "";
  try {
    if (ct.includes("application/json")) {
      return (await req.json()) as InBodyWebhookPayload;
    }
    const text = await req.text();
    if (!text) return null;
    // Try JSON first regardless of content-type header.
    try {
      return JSON.parse(text) as InBodyWebhookPayload;
    } catch {
      // Fallback: form-encoded body.
      const params = new URLSearchParams(text);
      const obj: Record<string, string> = {};
      params.forEach((v, k) => {
        obj[k] = v;
      });
      return Object.keys(obj).length ? (obj as InBodyWebhookPayload) : null;
    }
  } catch {
    return null;
  }
}
