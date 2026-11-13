import { NextResponse } from "next/server";
import { z } from "zod";
import { requireCallCenterApi } from "@/lib/call-center/access";
import {
  connectLinkUrl,
  createConnectLink,
  DEFAULT_LINK_DAYS,
  listConnectLinks,
  MAX_LINK_DAYS,
} from "@/lib/call-center/connect-link";
import { readJsonBody } from "@/lib/call-center/import-server";
import { logAudit } from "@/lib/audit";
import { requireStringParams } from "@/lib/route-params";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ clinicId: string }> };

const Body = z.strictObject({
  days: z.number().int().min(1).max(MAX_LINK_DAYS).optional(),
});

/** The clinic's recent connect links; only the live one carries its URL. */
export async function GET(req: Request, ctx: Ctx) {
  const params = await requireStringParams(ctx.params, ["clinicId"] as const);
  if (!params.ok) return params.response;
  const guard = await requireCallCenterApi(params.value.clinicId);
  if ("error" in guard) return guard.error;
  return NextResponse.json({ links: await listConnectLinks(guard.clinicId, new URL(req.url).origin) });
}

/** Make a new link (the old one stops working). */
export async function POST(req: Request, ctx: Ctx) {
  const params = await requireStringParams(ctx.params, ["clinicId"] as const);
  if (!params.ok) return params.response;
  const guard = await requireCallCenterApi(params.value.clinicId);
  if ("error" in guard) return guard.error;
  const raw = await readJsonBody(req, 4 * 1024);
  if (!raw.ok) return NextResponse.json({ error: raw.error }, { status: raw.status });
  const parsed = Body.safeParse(raw.value);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const { link, token, replaced } = await createConnectLink({
    clinicId: guard.clinicId,
    createdById: guard.session.user.id,
    days: parsed.data.days ?? DEFAULT_LINK_DAYS,
  });
  await logAudit({
    actorId: guard.session.user.id,
    actorRole: guard.session.user.originalRole,
    clinicId: guard.clinicId,
    action: "connect_link.create",
    targetType: "ClinicConnectLink",
    targetId: link.id,
    metadata: { days: parsed.data.days ?? DEFAULT_LINK_DAYS, replaced },
  });
  return NextResponse.json({
    link: {
      id: link.id,
      url: connectLinkUrl(token, new URL(req.url).origin),
      expiresAt: link.expiresAt?.toISOString() ?? null,
    },
  });
}
