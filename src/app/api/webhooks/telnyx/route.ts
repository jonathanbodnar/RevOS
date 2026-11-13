import { after, NextResponse } from "next/server";
import { verifyTelnyxSignature } from "@/lib/call-center/telnyx";
import { handleTelnyxEvent } from "@/lib/call-center/dialer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Telnyx call events (Call Control application + the agents' browser-phone
 * credential connection both point here).
 *
 * Verification: Ed25519 signature over `${telnyx-timestamp}|${raw body}` with
 * TELNYX_PUBLIC_KEY, timestamp within 5 minutes. Fails closed when the key is
 * unset. The event is handled after the 200 goes back (Telnyx expects a fast
 * reply); handlers are idempotent because Telnyx retries.
 */
export async function POST(req: Request) {
  if (!process.env.TELNYX_PUBLIC_KEY) {
    console.error("[telnyx] webhook rejected: TELNYX_PUBLIC_KEY is not set");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }
  const raw = await req.text();
  const ok = verifyTelnyxSignature({
    rawBody: raw,
    signature: req.headers.get("telnyx-signature-ed25519"),
    timestamp: req.headers.get("telnyx-timestamp"),
  });
  if (!ok) return NextResponse.json({ error: "Invalid signature" }, { status: 401 });

  let event: { event_type?: string; payload?: Record<string, unknown> } | undefined;
  try {
    event = (JSON.parse(raw) as { data?: typeof event })?.data;
  } catch {
    return NextResponse.json({ ok: true });
  }
  if (event?.event_type) {
    after(async () => {
      try {
        await handleTelnyxEvent(event as Parameters<typeof handleTelnyxEvent>[0]);
      } catch (e) {
        // 200 regardless (repo convention): a retry wouldn't fix a handler bug.
        console.error("[telnyx] event handling failed", event?.event_type, e);
      }
    });
  }
  return NextResponse.json({ ok: true });
}
