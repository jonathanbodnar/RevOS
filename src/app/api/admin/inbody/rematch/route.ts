import { NextResponse } from "next/server";
import { requireSuperAdminApi } from "@/lib/api-guard";
import { rematchAllUnmatchedInBodyTests } from "@/lib/inbody-ingest";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * Re-run phone pairing across every unmapped test.
 *
 * Deliberately makes no InBody API calls, so it stays useful while the data
 * API is returning 401 — pairing and metric-fetching are independent problems.
 */
export async function POST() {
  const guard = await requireSuperAdminApi();
  if ("error" in guard) return guard.error;

  const result = await rematchAllUnmatchedInBodyTests();

  await logAudit({
    actorId: guard.session.user.id ?? null,
    actorRole: guard.session.user.originalRole,
    clinicId: null,
    action: "inbody.rematch",
    targetType: "InBodyTest",
    targetId: null,
    metadata: result,
  });

  return NextResponse.json(result);
}
