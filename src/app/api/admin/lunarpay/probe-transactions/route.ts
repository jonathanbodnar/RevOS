import { NextResponse } from "next/server";
import { requireSuperAdminApi } from "@/lib/api-guard";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * READ-ONLY diagnostic. Probes the LunarPay REST API (with OUR secret key,
 * from the deployment's env) for any endpoint that can LIST charges /
 * transactions / subscription payment history — something the current client
 * (src/lib/lunarpay.ts) does not expose.
 *
 * We need this to decide how to backfill recurring/monthly charges that never
 * reached us via webhook. This endpoint performs only GET requests (no money
 * moves, no writes) and returns the exact status + (truncated) body LunarPay
 * gives back for each candidate path, seeded with a real subscription id and
 * customer id from our DB.
 *
 * Super-admin only. Usage:
 *   curl -X POST https://<domain>/api/admin/lunarpay/probe-transactions \
 *     -H "Cookie: <your session cookie>"
 * (or just open it in the browser while logged in as super admin — GET works too)
 */

const BASE_URL = process.env.LUNARPAY_BASE_URL || "https://app.lunarpay.com";
const SECRET_KEY = process.env.LUNARPAY_SECRET_KEY || "";

type Probe = {
  label: string;
  url: string;
  status?: number;
  ok: boolean;
  bodyPreview?: string;
  contentType?: string | null;
  networkError?: string;
};

async function get(label: string, path: string): Promise<Probe> {
  const url = `${BASE_URL}${path}`;
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${SECRET_KEY}`,
        Accept: "application/json",
      },
      cache: "no-store",
      redirect: "manual",
    });
    const text = await res.text();
    return {
      label,
      url,
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      contentType: res.headers.get("content-type"),
      // Truncate so an HTML login page or a huge list doesn't flood the response.
      bodyPreview: text.slice(0, 2000),
    };
  } catch (e) {
    return {
      label,
      url,
      ok: false,
      networkError: e instanceof Error ? e.message : String(e),
    };
  }
}

async function handle() {
  const guard = await requireSuperAdminApi();
  if ("error" in guard) return guard.error;

  if (!SECRET_KEY || SECRET_KEY.startsWith("lp_sk_replace")) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "LUNARPAY_SECRET_KEY is not configured on this deployment (still a placeholder).",
      },
      { status: 503 },
    );
  }

  // Seed with real ids so the per-resource probes are meaningful. Prefer an
  // active subscription whose next payment is already in the past (a known
  // "webhook was lost" case) so we probe an account that definitely charged.
  const sub =
    (await prisma.subscription.findFirst({
      where: { status: "active", nextPaymentOn: { lt: new Date() } },
      orderBy: { nextPaymentOn: "asc" },
      include: { customer: { select: { lunarpayCustomerId: true } } },
    })) ??
    (await prisma.subscription.findFirst({
      where: { status: "active" },
      orderBy: { createdAt: "asc" },
      include: { customer: { select: { lunarpayCustomerId: true } } },
    }));

  const subId = sub?.lunarpaySubscriptionId ?? null;
  const custId = sub?.customer?.lunarpayCustomerId ?? null;

  const paths: [string, string][] = [
    // Collection-level listings.
    ["list charges", "/api/v1/charges"],
    ["list charges (limit)", "/api/v1/charges?limit=5"],
    ["list transactions", "/api/v1/transactions"],
    ["list transactions (limit)", "/api/v1/transactions?limit=5"],
    ["list payments", "/api/v1/payments"],
    ["list subscriptions", "/api/v1/subscriptions"],
    ["list invoices", "/api/v1/invoices"],
  ];

  if (subId != null) {
    paths.push(
      ["get subscription (embeds history?)", `/api/v1/subscriptions/${subId}`],
      ["subscription payments", `/api/v1/subscriptions/${subId}/payments`],
      ["subscription transactions", `/api/v1/subscriptions/${subId}/transactions`],
      ["subscription charges", `/api/v1/subscriptions/${subId}/charges`],
      ["subscription invoices", `/api/v1/subscriptions/${subId}/invoices`],
    );
  }
  if (custId != null) {
    paths.push(
      ["customer charges", `/api/v1/customers/${custId}/charges`],
      ["customer transactions", `/api/v1/customers/${custId}/transactions`],
      ["customer payments", `/api/v1/customers/${custId}/payments`],
      ["get customer (amountAcum?)", `/api/v1/customers/${custId}`],
    );
  }

  const probes = await Promise.all(paths.map(([label, p]) => get(label, p)));

  return NextResponse.json({
    base: BASE_URL,
    secretKeyPrefix: SECRET_KEY.slice(0, 9),
    seededWith: { lunarpaySubscriptionId: subId, lunarpayCustomerId: custId },
    working: probes.filter((p) => p.ok).map((p) => p.label),
    probes,
  });
}

export async function POST() {
  return handle();
}

export async function GET() {
  return handle();
}
