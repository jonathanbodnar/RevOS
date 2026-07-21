import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { requireStringParams } from "@/lib/route-params";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const Body = z.object({ status: z.enum(["resolved", "dismissed", "open"]) });

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const guard = await requireClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;
  if (session.user.originalRole === "PROVIDER") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const params = await requireStringParams(ctx.params, ["id"] as const);
  if (!params.ok) return params.response;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const flag = await prisma.kPIFlag.findFirst({
    where: { id: params.value.id, clinicId },
    select: { id: true },
  });
  if (!flag) {
    return NextResponse.json({ error: "Flag not found" }, { status: 404 });
  }

  const resolving = parsed.data.status !== "open";
  const updated = await prisma.kPIFlag.update({
    where: { id: flag.id },
    data: {
      status: parsed.data.status,
      resolvedById: resolving ? session.user.id : null,
      resolvedAt: resolving ? new Date() : null,
    },
    select: { id: true, status: true },
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId,
    action: `kpi_flag.${parsed.data.status}`,
    targetType: "KPIFlag",
    targetId: flag.id,
  });

  return NextResponse.json({ data: updated });
}
