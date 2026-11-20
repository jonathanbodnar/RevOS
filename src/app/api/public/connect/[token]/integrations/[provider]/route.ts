import { NextResponse } from "next/server";
import { requireConnectLinkApi } from "@/lib/call-center/connect-link";
import { readJsonBody } from "@/lib/call-center/import-server";
import { ConnectBodySchema, connectIntegration, crmErrorResponse } from "@/lib/crm/integrations";
import { isCrmProvider } from "@/lib/crm/types";
import { requireStringParams } from "@/lib/route-params";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string; provider: string }> };

/** Clinic connect link: one step of connecting the clinic's CRM. */
export async function POST(req: Request, ctx: Ctx) {
  const params = await requireStringParams(ctx.params, ["token", "provider"] as const);
  if (!params.ok) return params.response;
  const link = await requireConnectLinkApi(req, ctx.params, "connect");
  if ("error" in link) return link.error;
  const provider = params.value.provider;
  if (!isCrmProvider(provider)) return NextResponse.json({ error: "Unknown CRM" }, { status: 404 });

  const raw = await readJsonBody(req, 16 * 1024);
  if (!raw.ok) return NextResponse.json({ error: raw.error }, { status: raw.status });
  const parsed = ConnectBodySchema.safeParse(raw.value);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  try {
    const result = await connectIntegration({
      clinicId: link.link.clinicId,
      provider,
      input: parsed.data.input,
      actor: { via: "clinic_link", actorId: null, actorRole: "CLINIC_LINK", linkId: link.link.id },
    });
    return NextResponse.json(result);
  } catch (e) {
    return crmErrorResponse(e);
  }
}
