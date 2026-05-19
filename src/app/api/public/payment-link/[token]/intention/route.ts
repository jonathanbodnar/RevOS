import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStringParams } from "@/lib/route-params";
import { calcFee } from "@/lib/fees";

/**
 * Mint a Fortis clientToken for the public payment-link page.
 *
 * Two intention shapes:
 *
 *   - One-time payment (mode === "payment"):
 *       transaction intention (amount only). Fortis charges in iframe.
 *       Backend just records the charge.
 *
 *   - Anything else (subscription / combined / installments, trial or not):
 *       action: "tokenization" (no amount). Fortis vaults the card with
 *       NO $0.01 verification charge. Backend then:
 *         1) attaches the vaulted card to the customer (savePaymentMethod)
 *         2) runs the day-of charge via createCharge (skipped for trials
 *            and for installments where the first payment is deferred)
 *         3) creates the LunarPay subscription / installment schedule
 *
 * We deliberately do NOT use action: "sale" because, in practice, Fortis
 * treats sale intentions as pure transactions and never fires
 * tokenize_success — which leaves us with no vault id for the recurring /
 * scheduled payments. Charging twice (once in iframe, once via createCharge)
 * is also error-prone. Doing the vault first then charging server-side
 * keeps the flow deterministic.
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

  const isOneTime = sess.mode === "payment";
  // Day-of base amount. Pure trials / deferred installments have 0 here.
  const dayOfBaseCents = isTrial ? 0 : sess.amountCents;
  const dayOfTotalCents = dayOfBaseCents > 0 ? calcFee(dayOfBaseCents).totalCents : 0;

  let intentionBody: Record<string, unknown>;
  let intentionType: "transaction" | "tokenization";
  if (isOneTime) {
    // Fortis charges in iframe. Backend just records the charge.
    intentionBody = {
      amount: calcFee(sess.amountCents).totalCents,
      paymentMethods: ["cc", "ach"],
    };
    intentionType = "transaction";
  } else {
    // Vault only. Backend handles every actual charge using the vaulted
    // payment method. We still include `amount` because Fortis Elements'
    // iframe validates the JWT and rejects intentions with no amount —
    // it doesn't actually charge here, just displays the amount in the UI.
    intentionBody = {
      action: "tokenization",
      amount: dayOfTotalCents, // 0 for trials / deferred installments
      paymentMethods: ["cc", "ach"],
    };
    intentionType = "tokenization";
  }

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
    // Always use OUR computed intentionType, never trust LunarPay's
    // response — Fortis classifies sale/tokenization differently internally
    // and that classification doesn't map 1:1 to our client routing.
    //   "transaction"  → done             → submit { transactionId }
    //   "tokenization" → tokenize_success → submit { tokenizeId, ... }
    intentionType,
    isTrial,
  });
}
