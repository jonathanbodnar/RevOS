import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperAdminApi } from "@/lib/api-guard";
import { renormalizeStoredInBodyResults } from "@/lib/inbody-ingest";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const Body = z.object({ limit: z.number().int().min(1).max(2000).optional() });

/**
 * Re-map metrics from already-stored raw payloads.
 *
 * Distinct from Backfill: this calls InBody zero times. When a field-name alias
 * is added, historical rows keep their old partial columns even though the full
 * payload is already sitting in `rawJson` — this re-runs normalization over
 * that stored JSON, so it works during an API outage and costs no daily quota.
 */
export async function POST(req: Request) {
  const guard = await requireSuperAdminApi();
  if ("error" in guard) return guard.error;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const summary = await renormalizeStoredInBodyResults(parsed.data.limit);

  await logAudit({
    actorId: guard.session.user.id ?? null,
    actorRole: guard.session.user.originalRole,
    action: "inbody.renormalize",
    targetType: "InBodyTest",
    targetId: null,
    metadata: {
      scanned: summary.scanned,
      updated: summary.updated,
      unreadable: summary.unreadable,
      errorCount: summary.errors.length,
    },
  });

  return NextResponse.json(summary);
}
