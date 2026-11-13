import { NextResponse } from "next/server";
import { requireCallCenterApi } from "@/lib/call-center/access";
import { crmErrorResponse, SyncBodySchema, syncIntegration } from "@/lib/crm/integrations";
import { isCrmProvider } from "@/lib/crm/types";
import { readJsonBody } from "@/lib/call-center/import-server";
import { requireStringParams } from "@/lib/route-params";

export const dynamic = "force-dynamic";

/**
 * "Sync now": pull one batch of leads from the CRM and import it. Call again
 * with the returned importId and cursor until done is true.
 */
export async function POST(req: Request, ctx: { params: Promise<{ clinicId: string; provider: string }> }) {
  const params = await requireStringParams(ctx.params, ["clinicId", "provider"] as const);
  if (!params.ok) return params.response;
  const guard = await requireCallCenterApi(params.value.clinicId);
  if ("error" in guard) return guard.error;
  const provider = params.value.provider;
  if (!isCrmProvider(provider)) return NextResponse.json({ error: "Unknown CRM" }, { status: 404 });

  const raw = await readJsonBody(req, 4 * 1024);
  if (!raw.ok) return NextResponse.json({ error: raw.error }, { status: raw.status });
  const parsed = SyncBodySchema.safeParse(raw.value);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  try {
    const result = await syncIntegration({
      clinicId: guard.clinicId,
      provider,
      importId: parsed.data.importId,
      cursor: parsed.data.cursor,
      actor: { via: "staff", actorId: guard.session.user.id, actorRole: guard.session.user.originalRole, linkId: null },
    });
    return NextResponse.json(result);
  } catch (e) {
    return crmErrorResponse(e);
  }
}
