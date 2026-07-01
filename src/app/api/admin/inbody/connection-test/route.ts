import { NextResponse } from "next/server";
import { requireSuperAdminClinicApi } from "@/lib/api-guard";
import { inbodyConnectionTest } from "@/lib/inbody";

export const dynamic = "force-dynamic";

/** Verify InBody Account + API-KEY credentials via POST /user/test. */
export async function POST() {
  const guard = await requireSuperAdminClinicApi();
  if ("error" in guard) return guard.error;

  const result = await inbodyConnectionTest();
  return NextResponse.json(result, { status: result.ok ? 200 : 200 });
}
