import { NextResponse } from "next/server";
import { requireSuperAdminApi } from "@/lib/api-guard";
import { logAudit } from "@/lib/audit";
import { reconcileRecurringCharges } from "@/lib/subscription-reconcile";

export const dynamic = "force-dynamic";
// Backfilling every subscription hits LunarPay once per sub, so allow headroom.
export const maxDuration = 300;

/**
 * Manually reconcile recurring charges (super-admin only).
 *
 * Safe by default: runs a DRY RUN and returns the plan without writing. Send
 * `{ "commit": true }` to actually create the backfilled `Charge` rows and
 * fast-forward the subscriptions' `nextPaymentOn`.
 *
 *   # preview
 *   curl -X POST .../api/admin/lunarpay/reconcile-subscriptions
 *   # apply
 *   curl -X POST .../api/admin/lunarpay/reconcile-subscriptions \
 *     -H 'Content-Type: application/json' -d '{"commit":true}'
 *   # scope to one subscription (our cuid)
 *   ... -d '{"commit":true,"subscriptionId":"cmp..."}'
 */
export async function POST(req: Request) {
  const guard = await requireSuperAdminApi();
  if ("error" in guard) return guard.error;

  const body = (await req.json().catch(() => ({}))) as {
    commit?: boolean;
    subscriptionId?: string;
  };
  const dryRun = body.commit !== true;

  const summary = await reconcileRecurringCharges({
    dryRun,
    subscriptionId: body.subscriptionId,
  });

  if (!dryRun) {
    await logAudit({
      actorId: guard.session.user.id ?? null,
      actorRole: "SUPER_ADMIN",
      clinicId: null,
      action: "subscription.reconcile",
      targetType: "Subscription",
      targetId: body.subscriptionId ?? "ALL",
      metadata: {
        scanned: summary.scanned,
        chargesCreated: summary.chargesCreated,
        subscriptionsAdvanced: summary.subscriptionsAdvanced,
        errors: summary.errors,
      },
    });
  }

  return NextResponse.json(summary);
}

// GET = convenient in-browser dry-run preview for super admins.
export async function GET() {
  const guard = await requireSuperAdminApi();
  if ("error" in guard) return guard.error;
  const summary = await reconcileRecurringCharges({ dryRun: true });
  return NextResponse.json(summary);
}
