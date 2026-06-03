import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { logAudit } from "@/lib/audit";

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (session?.user?.originalRole !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;
  await prisma.advancedCost.delete({ where: { id } });

  await logAudit({
    actorId: session.user.id,
    actorRole: "SUPER_ADMIN",
    clinicId: null,
    action: "advanced_cost.delete",
    targetType: "AdvancedCost",
    targetId: id,
  });

  return NextResponse.json({ ok: true });
}
