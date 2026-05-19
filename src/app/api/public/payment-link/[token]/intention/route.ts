import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStringParams } from "@/lib/route-params";
import { calcFee } from "@/lib/fees";

/**
 * Mint a Fortis clientToken for the public payment-link page.
 *
 * Three possible intention shapes:
 *
 *   - One-time payment (mode === "payment"):
 *       transaction intention (amount only). Fortis charges in iframe.
 *
 *   - Vault + charge today (sub starting today, combined w/ setup fee,
 *     installments where the first payment is today):
 *       action: "sale" + amount. Fortis charges the day-of amount AND
 *       vaults the card in one shot. Backend records the charge from
 *       the transactionId and uses the tokenizeId for the recurring/
 *       scheduled payments — it must NOT call createCharge again.
 *
 *   - Pure vault, no charge (trial subs, installments where the first
 *     payment is in the future, save-card flows):
 *       action: "tokenization" (no amount). Fortis vaults the card with
 *       NO $0.01 verification charge. Backend creates the subscription /
 *       schedule against the vault id.
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
  // Day-of money owed (always 0 for trials and for installments/combined
  // where nothing is due today). sess.amountCents already encodes whatever
  // the create-link route decided was the day-of base amount.
  const dayOfBaseCents = isTrial ? 0 : sess.amountCents;
  const dayOfTotalCents = dayOfBaseCents > 0 ? calcFee(dayOfBaseCents).totalCents : 0;

  let intentionBody: Record<string, unknown>;
  let intentionType: "transaction" | "sale" | "tokenization";
  if (isOneTime) {
    intentionBody = { amount: dayOfTotalCents, paymentMethods: ["cc", "ach"] };
    intentionType = "transaction";
  } else if (dayOfTotalCents > 0) {
    // Need to BOTH charge today AND vault for future sub/schedule payments.
    intentionBody = {
      action: "sale",
      amount: dayOfTotalCents,
      paymentMethods: ["cc", "ach"],
    };
    intentionType = "sale";
  } else {
    // Pure vault, no charge today.
    intentionBody = { action: "tokenization", paymentMethods: ["cc", "ach"] };
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
    // The client uses intentionType to decide which Fortis events to listen
    // for and what to send to the submit endpoint:
    //   "transaction"  → done       → { transactionId }
    //   "tokenization" → tokenize_success → { tokenizeId, ... }
    //   "sale"         → both → { transactionId, tokenizeId, ... }
    intentionType: (data.intentionType as string | undefined) ?? intentionType,
    isTrial,
  });
}
