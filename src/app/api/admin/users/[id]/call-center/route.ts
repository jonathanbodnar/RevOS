import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { requireStringParams } from "@/lib/route-params";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const Body = z.object({ clinicIds: z.array(z.string().min(10).max(40)).max(200) });

/** Set which clinics a call-center agent works (replaces the list). */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (session?.user?.originalRole !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const params = await requireStringParams(ctx.params, ["id"] as const);
  if (!params.ok) return params.response;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { id: params.value.id }, select: { id: true, role: true } });
  if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
  if (user.role !== "CALL_AGENT") {
    return NextResponse.json({ error: "Only call center users have clinic lists." }, { status: 400 });
  }
  const ids = Array.from(new Set(parsed.data.clinicIds));
  const found = await prisma.clinic.count({ where: { id: { in: ids } } });
  if (found !== ids.length) return NextResponse.json({ error: "Clinic not found" }, { status: 404 });

  await prisma.$transaction([
    prisma.callCenterAccess.deleteMany({ where: { userId: user.id, clinicId: { notIn: ids } } }),
    ...ids.map((clinicId) =>
      prisma.callCenterAccess.upsert({
        where: { userId_clinicId: { userId: user.id, clinicId } },
        create: { userId: user.id, clinicId },
        update: {},
      }),
    ),
  ]);
  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    action: "user.call_center_access",
    targetType: "User",
    targetId: user.id,
    metadata: { clinicIds: ids },
  });
  return NextResponse.json({ data: { clinicIds: ids } });
}
