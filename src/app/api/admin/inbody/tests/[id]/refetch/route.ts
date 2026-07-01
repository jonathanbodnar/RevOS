import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdminClinicApi } from "@/lib/api-guard";
import { refetchInBodyTest } from "@/lib/inbody-ingest";

export const dynamic = "force-dynamic";

/** Re-run auto-pairing + data fetch for a single InBody test. */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireSuperAdminClinicApi();
  if ("error" in guard) return guard.error;
  const { id } = await params;

  const test = await refetchInBodyTest(id);
  if (!test) return NextResponse.json({ error: "Test not found" }, { status: 404 });

  return NextResponse.json({
    ok: true,
    resultStatus: test.resultStatus,
    matchStatus: test.matchStatus,
    fetchError: test.fetchError,
  });
}
