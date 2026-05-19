import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireStringParams } from "@/lib/route-params";

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
  const res = await fetch(`${base}/api/v1/intentions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${pk}`,
      "Content-Type": "application/json",
    },
    // Pure vault — playbook says the body is exactly this, no `amount`.
    body: JSON.stringify({
      action: "tokenization",
      paymentMethods: ["cc"],
    }),
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    return NextResponse.json(
      { error: (data as { error?: string })?.error || "Upstream error" },
      { status: res.status },
    );
  }
  return NextResponse.json(data);
}
