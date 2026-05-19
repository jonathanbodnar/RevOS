import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStringParams } from "@/lib/route-params";
import { calcFee } from "@/lib/fees";

// POST routes are dynamic by default, but pin this explicitly to make sure
// the route handler never gets cached on the edge — the LunarPay clientToken
// is single-use and we must mint a fresh one on every page load.
export const dynamic = "force-dynamic";

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
  let intentionBody: Record<string, unknown>;
  let intentionType: "transaction" | "tokenization";
  if (isOneTime) {
    // One-time charge — Fortis charges the card in the iframe and our
    // backend records the resulting transaction. Explicit
    // `action: "sale"` is required (validated by 7-probe diagnostic).
    intentionBody = {
      action: "sale",
      amount: calcFee(sess.amountCents).totalCents,
      paymentMethods: ["cc", "ach"],
    };
    intentionType = "transaction";
  } else {
    // PURE vault — no charge, no $0.01 auth. We MUST send both "cc" and
    // "ach" in paymentMethods even though we only want cards: LunarPay's
    // /api/v1/intentions handler has a bug where requesting a single
    // payment method (paymentMethods: ["cc"]) attaches an unsupported
    // `product_transaction_id` to the Fortis tokenization request,
    // which Fortis then rejects with
    //   "\"product_transaction_id\" is not allowed".
    // Sending both methods routes LunarPay through their
    // `paymentMethod = "any"` branch which skips the bad field. The ACH
    // tab is hidden in the UI by the iframe crop, so the customer only
    // sees the card form anyway. Per 7-probe diagnostic this returns
    //   intentionType: "tokenization", amount: null
    // — exactly the no-charge vault flow we want.
    intentionBody = {
      action: "tokenization",
      paymentMethods: ["cc", "ach"],
    };
    intentionType = "tokenization";
  }

  // Verbose logging so we can prove from server logs exactly what we send
  // and exactly what LunarPay returns. The LunarPay error
  //   "Amount is required and must be an integer (in cents)"
  // ONLY fires when their validator sees data.action === "sale" — so if it
  // comes back, this log will show the literal body that triggered it.
  const bodyString = JSON.stringify(intentionBody);
  const fullUrl = `${base}/api/v1/intentions`;
  // Log key prefix only — never log full credentials.
  const pkPrefix = pk.slice(0, 8); // e.g. "lp_pk_ab"
  console.info(
    `[intention/payment-link] token=${token} mode=${sess.mode} →`,
    `POST ${fullUrl}`,
    `auth=Bearer ${pkPrefix}…(len=${pk.length})`,
    `body=${bodyString}`,
  );

  const res = await fetch(fullUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pk}`,
      "Content-Type": "application/json",
    },
    body: bodyString,
    cache: "no-store",
    redirect: "manual",
  });

  // Capture response headers too — if LunarPay 3xx-redirects us to the
  // deprecated endpoint that defaults action: "sale", we'll see it here.
  const respHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    respHeaders[k] = v;
  });

  const rawText = await res.text();
  let data: { clientToken?: string; intentionType?: string; error?: string; message?: string } = {};
  try {
    data = JSON.parse(rawText);
  } catch {
    // not JSON — leave data empty and rely on rawText below
  }

  console.info(
    `[intention/payment-link] LunarPay response status=${res.status}`,
    `headers=${JSON.stringify(respHeaders)}`,
    `body=${rawText}`,
  );

  if (!res.ok) {
    return NextResponse.json(
      {
        error: data.error || data.message || "Upstream error",
        diagnostics: {
          requestUrl: fullUrl,
          requestAuthPrefix: pkPrefix,
          requestBody: intentionBody,
          responseStatus: res.status,
          responseHeaders: respHeaders,
          responseBody: rawText,
        },
      },
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
