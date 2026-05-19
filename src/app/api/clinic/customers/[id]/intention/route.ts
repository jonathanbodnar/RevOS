import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";

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
  const res = await fetch(`${base}/api/v1/intentions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pk}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "tokenization", paymentMethods: ["cc"] }),
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return NextResponse.json(
      { error: (data as { error?: string })?.error || "Intention failed" },
      { status: res.status },
    );
  }
  return NextResponse.json(data);
}
