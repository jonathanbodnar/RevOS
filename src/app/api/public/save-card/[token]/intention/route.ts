import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStringParams } from "@/lib/route-params";

export const dynamic = "force-dynamic";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const params = await requireStringParams(ctx.params, ["token"] as const);
  if (!params.ok) return params.response;
  const { token } = params.value;
  const sess = await prisma.checkoutSession.findUnique({ where: { token } });
  if (!sess || sess.mode !== "save_card" || sess.status !== "open") {
    return NextResponse.json({ error: "Link expired or invalid" }, { status: 404 });
  }
  const pk = process.env.LUNARPAY_PUBLISHABLE_KEY;
  const base = process.env.LUNARPAY_BASE_URL || "https://app.lunarpay.com";
  if (!pk) {
    return NextResponse.json({ error: "Payments not configured" }, { status: 503 });
  }
  // Pure vault — no charge. We MUST send both "cc" and "ach" to bypass a
  // LunarPay-side bug where paymentMethods: ["cc"] attaches an
  // unsupported `product_transaction_id` to the Fortis tokenization
  // request (Fortis rejects it). Both methods → `paymentMethod = "any"`
  // on LunarPay's side → product_transaction_id branch skipped → 200.
  // The ACH tab is cropped out of the UI so the customer only sees the
  // card form anyway.
  const intentionBody = {
    action: "tokenization",
    paymentMethods: ["cc", "ach"],
  };
  const bodyString = JSON.stringify(intentionBody);
  console.info(
    `[intention/save-card] token=${token} → POST ${base}/api/v1/intentions body=${bodyString}`,
  );
  const res = await fetch(`${base}/api/v1/intentions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pk}`,
      "Content-Type": "application/json",
    },
    body: bodyString,
    cache: "no-store",
  });
  const rawText = await res.text();
  let data: { error?: string; message?: string } = {};
  try {
    data = JSON.parse(rawText);
  } catch {
    // not JSON
  }
  console.info(
    `[intention/save-card] LunarPay response status=${res.status} body=${rawText}`,
  );
  if (!res.ok) {
    return NextResponse.json(
      {
        error: data.error || data.message || "Upstream error",
        sentBody: intentionBody,
        lunarPayResponse: rawText,
      },
      { status: res.status },
    );
  }
  return NextResponse.json(data);
}
