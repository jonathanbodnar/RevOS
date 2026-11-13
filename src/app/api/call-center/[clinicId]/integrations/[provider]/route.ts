import { NextResponse } from "next/server";
import { requireCallCenterApi } from "@/lib/call-center/access";
import {
  ConnectBodySchema,
  connectIntegration,
  crmErrorResponse,
  disconnectIntegration,
} from "@/lib/crm/integrations";
import { isCrmProvider } from "@/lib/crm/types";
import { readJsonBody } from "@/lib/call-center/import-server";
import { requireStringParams } from "@/lib/route-params";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ clinicId: string; provider: string }> };

async function guarded(ctx: Ctx) {
  const params = await requireStringParams(ctx.params, ["clinicId", "provider"] as const);
  if (!params.ok) return { error: params.response };
  const guard = await requireCallCenterApi(params.value.clinicId);
  if ("error" in guard) return guard;
  const provider = params.value.provider;
  if (!isCrmProvider(provider)) {
    return { error: NextResponse.json({ error: "Unknown CRM" }, { status: 404 }) };
  }
  return { ...guard, provider };
}

/** Run one connect step (API key, center pick, approval check…). */
export async function POST(req: Request, ctx: Ctx) {
  const g = await guarded(ctx);
  if ("error" in g) return g.error;
  const raw = await readJsonBody(req, 16 * 1024);
  if (!raw.ok) return NextResponse.json({ error: raw.error }, { status: raw.status });
  const parsed = ConnectBodySchema.safeParse(raw.value);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  try {
    const result = await connectIntegration({
      clinicId: g.clinicId,
      provider: g.provider,
      input: parsed.data.input,
      actor: { via: "staff", actorId: g.session.user.id, actorRole: g.session.user.originalRole, linkId: null },
    });
    return NextResponse.json(result);
  } catch (e) {
    return crmErrorResponse(e);
  }
}

/** Disconnect: forget the credentials. Imported leads stay. */
export async function DELETE(_req: Request, ctx: Ctx) {
  const g = await guarded(ctx);
  if ("error" in g) return g.error;
  const view = await disconnectIntegration({
    clinicId: g.clinicId,
    provider: g.provider,
    actor: { via: "staff", actorId: g.session.user.id, actorRole: g.session.user.originalRole, linkId: null },
  });
  if (!view) return NextResponse.json({ error: "Not connected" }, { status: 404 });
  return NextResponse.json({ view });
}
