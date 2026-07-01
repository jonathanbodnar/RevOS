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
  if (secret) {
    let ok = false;
    req.headers.forEach((value) => {
      if (value === secret) ok = true;
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

  try {
    const test = await ingestInBodyNotification(payload);
    // eslint-disable-next-line no-console
    console.info(
      `[inbody] ingested test ${test.id} phone=${test.phoneNormalized ?? "?"} match=${test.matchStatus} result=${test.resultStatus}`,
    );
    return NextResponse.json({ success: true, id: test.id, matched: Boolean(test.customerId) });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[inbody] webhook ingest failed", err);
    return NextResponse.json({ error: "Ingest failed" }, { status: 500 });
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
