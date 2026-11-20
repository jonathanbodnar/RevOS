import { NextResponse } from "next/server";
import { requireCallCenterApi } from "@/lib/call-center/access";
import { integrationViews } from "@/lib/crm/integrations";
import { requireStringParams } from "@/lib/route-params";

export const dynamic = "force-dynamic";

/** The clinic's CRM connections (status only, never credentials). */
export async function GET(_req: Request, ctx: { params: Promise<{ clinicId: string }> }) {
  const params = await requireStringParams(ctx.params, ["clinicId"] as const);
  if (!params.ok) return params.response;
  const guard = await requireCallCenterApi(params.value.clinicId);
  if ("error" in guard) return guard.error;
  return NextResponse.json({ integrations: await integrationViews(guard.clinicId) });
}
