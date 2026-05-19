import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * One-shot diagnostic endpoint. Hits LunarPay's /api/v1/intentions with the
 * EXACT body from the LunarPay playbook (no amount, action: tokenization,
 * paymentMethods: ["cc"]) from OUR Vercel server using OUR env credentials,
 * and returns everything we observed — request URL, key prefix, response
 * status, response headers, and raw response body.
 *
 * Purpose: prove definitively whether the bug is on LunarPay's side or in
 * our server's view of the world (wrong env var, deprecated base URL, etc.).
 *
 * Usage:
 *   curl -X POST https://<your-domain>/api/debug/lunarpay-intentions
 *
 * (No auth required — read-only diagnostic, no PII, no LunarPay write.)
 */
export async function POST() {
  const pk = process.env.LUNARPAY_PUBLISHABLE_KEY;
  const base = process.env.LUNARPAY_BASE_URL || "https://app.lunarpay.com";

  if (!pk) {
    return NextResponse.json(
      {
        ok: false,
        error: "LUNARPAY_PUBLISHABLE_KEY not configured on this deployment.",
        env: {
          LUNARPAY_BASE_URL: base,
          LUNARPAY_PUBLISHABLE_KEY: "(not set)",
        },
      },
      { status: 503 },
    );
  }

  const fullUrl = `${base}/api/v1/intentions`;
  const pkPrefix = pk.slice(0, 8);

  // Playbook-exact body. If LunarPay still returns the sale-validator error
  // here, the bug is 100% on their side — this body matches their own
  // example character for character.
  const intentionBody = {
    action: "tokenization",
    paymentMethods: ["cc"],
  };

  let networkError: string | null = null;
  let status = 0;
  let respHeaders: Record<string, string> = {};
  let rawText = "";

  try {
    const res = await fetch(fullUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pk}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(intentionBody),
      cache: "no-store",
      redirect: "manual",
    });
    status = res.status;
    res.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });
    rawText = await res.text();
  } catch (e) {
    networkError = e instanceof Error ? e.message : String(e);
  }

  console.info(
    "[debug/lunarpay-intentions]",
    `url=${fullUrl}`,
    `auth=Bearer ${pkPrefix}…(len=${pk.length})`,
    `status=${status}`,
    `headers=${JSON.stringify(respHeaders)}`,
    `body=${rawText}`,
    networkError ? `networkError=${networkError}` : "",
  );

  return NextResponse.json({
    ok: !networkError && status >= 200 && status < 300,
    env: {
      LUNARPAY_BASE_URL: base,
      LUNARPAY_PUBLISHABLE_KEY_prefix: pkPrefix,
      LUNARPAY_PUBLISHABLE_KEY_length: pk.length,
      LUNARPAY_PUBLISHABLE_KEY_kind: pk.startsWith("lp_pk_")
        ? "publishable"
        : pk.startsWith("lp_sk_")
        ? "SECRET (wrong — should be publishable!)"
        : "unknown prefix",
    },
    request: {
      url: fullUrl,
      method: "POST",
      headers: {
        Authorization: `Bearer ${pkPrefix}…`,
        "Content-Type": "application/json",
      },
      body: intentionBody,
    },
    response: networkError
      ? { networkError }
      : {
          status,
          headers: respHeaders,
          body: rawText,
        },
  });
}

export async function GET() {
  return POST();
}
