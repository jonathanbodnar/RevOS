import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { requireStringParams } from "@/lib/route-params";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

async function guard() {
  const session = await getSession();
  if (session?.user?.originalRole !== "SUPER_ADMIN") return null;
  return session;
}

const Patch = z.object({ isActive: z.boolean() });

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await guard();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const params = await requireStringParams(ctx.params, ["id"] as const);
  if (!params.ok) return params.response;
  const parsed = Patch.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const kpi = await prisma.kPI.update({
    where: { id: params.value.id },
    data: { isActive: parsed.data.isActive },
    select: { id: true, isActive: true },
  });
  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId: null,
    action: parsed.data.isActive ? "kpi.activate" : "kpi.deactivate",
    targetType: "KPI",
    targetId: kpi.id,
  });
  return NextResponse.json({ data: kpi });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await guard();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const params = await requireStringParams(ctx.params, ["id"] as const);
  if (!params.ok) return params.response;
  await prisma.kPI.delete({ where: { id: params.value.id } });
  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId: null,
    action: "kpi.delete",
    targetType: "KPI",
    targetId: params.value.id,
  });
  return NextResponse.json({ ok: true });
}
