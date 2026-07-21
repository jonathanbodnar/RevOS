import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { evaluateKpis } from "@/lib/kpi";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Nightly KPI evaluation. Computes each active KPI per customer and raises
 * KPIFlags (idempotent per day). Same auth model as the reconcile cron:
 * requires `Authorization: Bearer $CRON_SECRET`; disabled when unset.
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

  const summary = await evaluateKpis({ dryRun: false });

  await logAudit({
    actorId: null,
    actorRole: "CRON",
    clinicId: null,
    action: "kpi.evaluate.cron",
    targetType: "KPI",
    targetId: "ALL",
    metadata: { ...summary },
  });

  return NextResponse.json({ ok: true, ...summary });
}
