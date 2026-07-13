import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { reconcileRecurringCharges } from "@/lib/subscription-reconcile";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Daily reconciliation cron (scheduled in vercel.json). Self-heals recurring
 * charges that never arrived via the `payment.succeeded` webhook: it backfills
 * the missing `Charge` rows and fast-forwards each subscription's
 * `nextPaymentOn` to match LunarPay. The webhook remains the primary path;
 * this is the safety net for lost deliveries.
 *
 * Auth: Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. When CRON_SECRET
 * is set we require it; if unset (e.g. local dev), the route is disabled to
 * avoid an unauthenticated write endpoint in production by accident.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "CRON_SECRET is not configured; cron disabled." },
      { status: 503 },
    );
  }
  const auth = req.headers.get("authorization") ?? "";
  if (auth !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const summary = await reconcileRecurringCharges({ dryRun: false });

  await logAudit({
    actorId: null,
    actorRole: "CRON",
    clinicId: null,
    action: "subscription.reconcile.cron",
    targetType: "Subscription",
    targetId: "ALL",
    metadata: {
      scanned: summary.scanned,
      chargesCreated: summary.chargesCreated,
      subscriptionsAdvanced: summary.subscriptionsAdvanced,
      errors: summary.errors,
    },
  });

  return NextResponse.json({
    ok: true,
    scanned: summary.scanned,
    chargesCreated: summary.chargesCreated,
    subscriptionsAdvanced: summary.subscriptionsAdvanced,
    errors: summary.errors,
  });
}
