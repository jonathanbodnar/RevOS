import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSuperAdminClinicApi } from "@/lib/api-guard";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { logAudit } from "@/lib/audit";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const guard = await requireSuperAdminClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;
  const { id } = await ctx.params;

  const sub = await prisma.subscription.findFirst({
    where: { id, clinicId },
  });
  if (!sub) {
    return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
  }
  try {
    await lunarpay.cancelSubscription(sub.lunarpaySubscriptionId);
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: "cancelled" },
    });
    await logAudit({
      actorId: session.user.id,
      actorRole: session.user.originalRole,
      clinicId,
      action: "subscription.cancel",
      targetType: "Subscription",
      targetId: sub.id,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const status = e instanceof LunarPayError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Cancel failed.";
    return NextResponse.json({ error: msg }, { status });
  }
}
