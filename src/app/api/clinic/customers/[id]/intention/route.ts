import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";

export const dynamic = "force-dynamic";

/**
 * Mint a Fortis `clientToken` the admin's browser can use to mount
 * the Fortis Elements iframe. We hit LunarPay with the publishable key
 * (safe to use without the secret key) and request a tokenization intention
 * so the card is vaulted with NO $0.01 verification charge.
 */
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const guard = await requireClinicApi();
  if ("error" in guard) return guard.error;
  const { clinicId } = guard;
  const { id } = await ctx.params;

  const customer = await prisma.customer.findFirst({
    where: { id, clinicId },
  });
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  const pk = process.env.LUNARPAY_PUBLISHABLE_KEY;
  const base = process.env.LUNARPAY_BASE_URL || "https://app.lunarpay.com";
  if (!pk) {
    return NextResponse.json(
      { error: "LUNARPAY_PUBLISHABLE_KEY not configured" },
      { status: 503 },
    );
  }
  // Pure vault — no charge. We MUST send both "cc" and "ach" to bypass a
  // LunarPay-side bug where paymentMethods: ["cc"] attaches an
  // unsupported `product_transaction_id` to the Fortis tokenization
  // request (Fortis rejects it). Both methods → `paymentMethod = "any"`
  // on LunarPay's side → product_transaction_id branch skipped → 200.
  // The ACH tab is cropped out of the modal UI so the admin only sees
  // the card form anyway.
  const intentionBody = {
    action: "tokenization",
    paymentMethods: ["cc", "ach"],
  };
  const bodyString = JSON.stringify(intentionBody);
  console.info(
    `[intention/clinic-customer] customerId=${id} → POST ${base}/api/v1/intentions body=${bodyString}`,
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
    `[intention/clinic-customer] LunarPay response status=${res.status} body=${rawText}`,
  );
  if (!res.ok) {
    return NextResponse.json(
      {
        error: data.error || data.message || "Intention failed",
        sentBody: intentionBody,
        lunarPayResponse: rawText,
      },
      { status: res.status },
    );
  }
  return NextResponse.json(data);
}
