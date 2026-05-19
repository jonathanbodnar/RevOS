import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStringParams } from "@/lib/route-params";
import { calcFee } from "@/lib/fees";

/**
 * Mint a Fortis clientToken for the public payment-link page.
 *
 * Intention type depends on the link mode:
 *   - "payment" → transaction intention: Fortis charges the card directly
 *                 inside the iframe. Backend must NOT charge again.
 *   - "subscription" / "combined" / "installments" / trial
 *                → tokenization intention: Fortis vaults the card with NO
 *                  $0.01 verification charge. Backend creates the
 *                  subscription / installment schedule against the vault id.
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

  // One-time payments: transaction intention → Fortis charges in iframe.
  // Anything else: tokenization intention → card vaulted with no $0.01 auth.
  const isOneTime = sess.mode === "payment";
  const { totalCents } = calcFee(sess.amountCents);
  const intentionBody = isOneTime
    ? { amount: totalCents, paymentMethods: ["cc", "ach"] }
    : { action: "tokenization", paymentMethods: ["cc", "ach"] };

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
    // happened in the iframe ("transaction") or whether it should listen for
    // tokenize_success and send a tokenizeId ("tokenization").
    intentionType:
      data.intentionType ?? (isOneTime ? "transaction" : "tokenization"),
    isTrial,
  });
}
