import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { runRetention } from "@/lib/retention";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Data-retention purge cron. Same auth model as the other crons: requires
 * `Authorization: Bearer $CRON_SECRET`; disabled when unset. Deletes nothing
 * unless the per-class retention windows are configured (see src/lib/retention).
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

  const summary = await runRetention({ dryRun: false });

  await logAudit({
    actorId: null,
    actorRole: "CRON",
    clinicId: null,
    action: "data.retention.purge",
    targetType: null,
    targetId: null,
    metadata: { ...summary },
  });

  return NextResponse.json({ ok: true, ...summary });
}
