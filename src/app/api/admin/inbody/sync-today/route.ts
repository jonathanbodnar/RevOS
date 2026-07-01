import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdminClinicApi } from "@/lib/api-guard";
import { syncInBodyMeasurementsForDate } from "@/lib/inbody-ingest";

export const dynamic = "force-dynamic";

/**
 * Manually pull every InBody test recorded on a given date (default today)
 * directly from the InBody Web API — independent of webhook delivery. Useful
 * for backfilling existing/live data once InBody's account has full data-API
 * access enabled (GetTodayMeasurements requires elevated permissions beyond
 * the basic connection test).
 */
export async function POST(req: NextRequest) {
  const guard = await requireSuperAdminClinicApi();
  if ("error" in guard) return guard.error;

  const body = (await req.json().catch(() => ({}))) as { date?: string };
  const result = await syncInBodyMeasurementsForDate(body.date);
  return NextResponse.json(result);
}
