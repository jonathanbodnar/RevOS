import { NextResponse } from "next/server";
import { requireConnectLinkApi } from "@/lib/call-center/connect-link";
import { readJsonBody } from "@/lib/call-center/import-server";
import { crmErrorResponse, SyncBodySchema, syncIntegration } from "@/lib/crm/integrations";
import { isCrmProvider } from "@/lib/crm/types";
import { requireStringParams } from "@/lib/route-params";

export const dynamic = "force-dynamic";

/**
 * Clinic connect link: pull one batch of leads from the connected CRM right
 * after connecting. Answers with how many records came from the CRM, never
 * with what RevOS already had (see the imports route).
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string; provider: string }> }) {
  const params = await requireStringParams(ctx.params, ["token", "provider"] as const);
  if (!params.ok) return params.response;
  const link = await requireConnectLinkApi(req, ctx.params, "upload");
  if ("error" in link) return link.error;
  const provider = params.value.provider;
  if (!isCrmProvider(provider)) return NextResponse.json({ error: "Unknown CRM" }, { status: 404 });

  const raw = await readJsonBody(req, 4 * 1024);
  if (!raw.ok) return NextResponse.json({ error: raw.error }, { status: raw.status });
  const parsed = SyncBodySchema.safeParse(raw.value);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  try {
    const result = await syncIntegration({
      clinicId: link.link.clinicId,
      provider,
      importId: parsed.data.importId,
      cursor: parsed.data.cursor,
      actor: { via: "clinic_link", actorId: null, actorRole: "CLINIC_LINK", linkId: link.link.id },
    });
    return NextResponse.json({
      importId: result.importId,
      cursor: result.cursor,
      done: result.done,
      counts: { received: result.counts.received, invalid: result.counts.invalid },
    });
  } catch (e) {
    return crmErrorResponse(e);
  }
}
