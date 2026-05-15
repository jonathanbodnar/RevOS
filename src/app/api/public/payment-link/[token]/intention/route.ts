import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStringParams } from "@/lib/route-params";

/**
 * Mint a Fortis clientToken for the public payment-link page.
 *
 * Intention type depends on the link mode:
 *   - "payment"  → transaction intention: Fortis charges the card directly
 *                  inside the iframe. Backend must NOT charge again.
 *   - "subscription" / "combined" / trial
 *                → ticket intention (hasRecurring: true): Fortis only saves
 *                  the card. Backend charges setup fee and creates subscription.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const params = await requireStringParams(ctx.params, ["token"] as const);
  if (!params.ok) return params.response;
  const { token } = params.value;

  const sess = await prisma.checkoutSession.findUnique({ where: { token } });
  if (
    !sess ||
    !["payment", "subscription", "combined", "installments"].includes(sess.mode) ||
    sess.status !== "open"
  ) {
    return NextResponse.json(
      { error: "Link expired or invalid" },
      { status: 404 },
    );
  }

  const pk = process.env.LUNARPAY_PUBLISHABLE_KEY;
  const base = process.env.LUNARPAY_BASE_URL || "https://app.lunarpay.com";
  if (!pk) {
    return NextResponse.json(
      { error: "Payments not configured" },
      { status: 503 },
    );
  }

  // Parse metadata so we can detect trial subscriptions.
  const meta = sess.metadataJson
    ? (JSON.parse(sess.metadataJson) as Record<string, unknown>)
    : {};
  const isTrial = !!meta.trial;

  // One-time payments: use a transaction intention so Fortis charges the card
  // directly in the iframe — no backend charge call needed.
  // Everything else (subscription, combined, trial, installments): use a ticket
  // intention (hasRecurring: true) so the card is vaulted without charging.
  const isOneTime = sess.mode === "payment";
  const intentionBody = isOneTime
    ? { amount: sess.amountCents, paymentMethods: ["cc", "ach"] }
    : { hasRecurring: true, paymentMethods: ["cc", "ach"] };

  const res = await fetch(`${base}/api/v1/intentions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pk}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(intentionBody),
    cache: "no-store",
  });

  const data = (await res.json().catch(() => ({}))) as {
    clientToken?: string;
    intentionType?: string;
    error?: string;
  };

  if (!res.ok) {
    return NextResponse.json(
      { error: data.error || "Upstream error" },
      { status: res.status },
    );
  }

  return NextResponse.json({
    clientToken: data.clientToken,
    // Expose intentionType so the client knows whether the charge already
    // happened in the iframe (transaction) or needs to be done server-side
    // (ticket).
    intentionType: data.intentionType ?? (isOneTime ? "transaction" : "ticket"),
    isTrial,
  });
}
