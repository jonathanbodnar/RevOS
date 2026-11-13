import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { loadRules } from "@/lib/call-center/access";
import { RulesInput } from "@/lib/call-center/rules";
import { bad, clinicRoute, readJson } from "@/lib/call-center/route-helpers";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ clinicId: string }> }) {
  const r = await clinicRoute(ctx.params);
  if ("error" in r) return r.error;
  return NextResponse.json({ data: await loadRules(r.clinicId) });
}

/** Save this clinic's call rules (call center agents and super admins). */
export async function PUT(req: Request, ctx: { params: Promise<{ clinicId: string }> }) {
  const r = await clinicRoute(ctx.params);
  if ("error" in r) return r.error;
  const parsed = RulesInput.safeParse(await readJson(req));
  if (!parsed.success) return bad(parsed.error.issues[0]?.message ?? "Check the rules.");
  const before = await loadRules(r.clinicId);
  const data = { ...parsed.data, updatedById: r.session.user.id };
  const saved = await prisma.callRules.upsert({
    where: { clinicId: r.clinicId },
    create: { clinicId: r.clinicId, ...data },
    update: data,
  });
  const changed = (Object.keys(parsed.data) as (keyof typeof parsed.data)[]).filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(parsed.data[k]),
  );
  await logAudit({
    actorId: r.session.user.id,
    actorRole: r.session.user.originalRole,
    clinicId: r.clinicId,
    action: "call_rules.update",
    targetType: "CallRules",
    targetId: r.clinicId,
    metadata: { changed },
  });
  return NextResponse.json({ data: saved });
}
