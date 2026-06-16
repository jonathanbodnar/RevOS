import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSuperAdminClinicApi } from "@/lib/api-guard";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { logAudit } from "@/lib/audit";

/**
 * Push an active subscription's next charge / renewal date to a new date.
 *
 * LunarPay's PATCH /subscriptions supports nextPaymentOn directly, so this is a
 * simple repoint — no charge happens now, the next cron charge just lands on
 * the new date instead.
 */
const Body = z.object({
  // Plain YYYY-MM-DD from a <input type="date">.
  nextPaymentOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const guard = await requireSuperAdminClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;
  const { id } = await ctx.params;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message || "Invalid input" },
      { status: 400 },
    );
  }

  // Reject dates in the past — LunarPay would either reject or charge instantly.
  const target = new Date(`${parsed.data.nextPaymentOn}T00:00:00Z`);
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  if (target.getTime() < todayStart.getTime()) {
    return NextResponse.json(
      { error: "Pick a date today or later." },
      { status: 400 },
    );
  }

  const sub = await prisma.subscription.findFirst({ where: { id, clinicId } });
  if (!sub) {
    return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
  }
  if (sub.status !== "active") {
    return NextResponse.json(
      { error: "Only active subscriptions can be rescheduled." },
      { status: 400 },
    );
  }

  const nextPaymentOnIso = target.toISOString().replace(".000Z", "Z");

  try {
    const lpSub = await lunarpay.updateSubscription(sub.lunarpaySubscriptionId, {
      nextPaymentOn: nextPaymentOnIso,
    });

    const nextPaymentOn = lpSub.data.nextPaymentOn
      ? new Date(lpSub.data.nextPaymentOn)
      : target;

    const updated = await prisma.subscription.update({
      where: { id: sub.id },
      data: { nextPaymentOn },
    });

    await logAudit({
      actorId: session.user.id,
      actorRole: session.user.originalRole,
      clinicId,
      action: "subscription.reschedule",
      targetType: "Subscription",
      targetId: sub.id,
      metadata: {
        oldNextPaymentOn: sub.nextPaymentOn?.toISOString() ?? null,
        newNextPaymentOn: nextPaymentOn.toISOString(),
      },
    });

    return NextResponse.json({ data: { id: updated.id } });
  } catch (e) {
    const status = e instanceof LunarPayError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Failed to reschedule.";
    return NextResponse.json({ error: msg }, { status });
  }
}
