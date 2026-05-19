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
type ProbeResult = {
  label: string;
  body: Record<string, unknown>;
  status?: number;
  ok: boolean;
  responseBody?: string;
  responseHeaders?: Record<string, string>;
  networkError?: string;
};

async function probe(
  fullUrl: string,
  pk: string,
  label: string,
  body: Record<string, unknown>,
): Promise<ProbeResult> {
  try {
    const res = await fetch(fullUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pk}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      redirect: "manual",
    });
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });
    const rawText = await res.text();
    return {
      label,
      body,
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      responseBody: rawText,
      responseHeaders: respHeaders,
    };
  } catch (e) {
    return {
      label,
      body,
      ok: false,
      networkError: e instanceof Error ? e.message : String(e),
    };
  }
}

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

  // Try a series of bodies to figure out which one (if any) gets us a
  // clientToken back. The first one is the playbook-exact body that
  // LunarPay support says should work; the rest are progressively-more-
  // tolerant fallbacks that probe different validator branches.
  const probes = await Promise.all([
    probe(fullUrl, pk, "playbook tokenization (cc only)", {
      action: "tokenization",
      paymentMethods: ["cc"],
    }),
    probe(fullUrl, pk, "tokenization + amount=0", {
      action: "tokenization",
      amount: 0,
      paymentMethods: ["cc"],
    }),
    probe(fullUrl, pk, "tokenization + amount=1 (1 cent)", {
      action: "tokenization",
      amount: 1,
      paymentMethods: ["cc"],
    }),
    probe(fullUrl, pk, "tokenization + amount=100", {
      action: "tokenization",
      amount: 100,
      paymentMethods: ["cc"],
    }),
    probe(fullUrl, pk, "legacy hasRecurring ticket (cc)", {
      hasRecurring: true,
      paymentMethods: ["cc"],
    }),
    probe(fullUrl, pk, "legacy hasRecurring ticket + amount=1", {
      hasRecurring: true,
      amount: 1,
      paymentMethods: ["cc"],
    }),
    probe(fullUrl, pk, "sale + amount=1 (cents)", {
      action: "sale",
      amount: 1,
      paymentMethods: ["cc"],
    }),
  ]);

  const firstWorking = probes.find((p) => p.ok);

  return NextResponse.json({
    summary: {
      anyProbeWorked: !!firstWorking,
      firstWorkingLabel: firstWorking?.label ?? null,
    },
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
    requestUrl: fullUrl,
    probes,
  });
}

export async function GET() {
  return POST();
}
