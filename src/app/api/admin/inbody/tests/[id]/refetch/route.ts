import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdminApi } from "@/lib/api-guard";
import { logAudit } from "@/lib/audit";
import { refetchInBodyTest } from "@/lib/inbody-ingest";

export const dynamic = "force-dynamic";

/** Re-run auto-pairing + data fetch for a single InBody test. */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireSuperAdminApi();
  if ("error" in guard) return guard.error;
  const { id } = await params;

  const test = await refetchInBodyTest(id);
  if (!test) return NextResponse.json({ error: "Test not found" }, { status: 404 });

  await logAudit({
    actorId: guard.session.user.id ?? null,
    actorRole: guard.session.user.originalRole,
    clinicId: test.clinicId,
    action: "inbody.refetch",
    targetType: "InBodyTest",
    targetId: test.id,
    metadata: { resultStatus: test.resultStatus, matchStatus: test.matchStatus },
  });

  return NextResponse.json({
    ok: true,
    resultStatus: test.resultStatus,
    matchStatus: test.matchStatus,
    fetchError: test.fetchError,
  });
}
