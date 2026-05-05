import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { logAudit } from "@/lib/audit";

/**
 * Super-admin "login as clinic".
 *
 * We don't actually swap JWT identity — instead we record the action
 * server-side for audit, and the client calls `update()` on the session to
 * set `impersonatingClinicId` on the JWT. Middleware / page code reads
 * `session.user.effectiveClinicId` to scope queries.
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (session?.user?.originalRole !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = z
    .object({ clinicId: z.string().min(1) })
    .safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const clinic = await prisma.clinic.findUnique({
    where: { id: body.data.clinicId },
  });
  if (!clinic) {
    return NextResponse.json({ error: "Clinic not found" }, { status: 404 });
  }

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId: clinic.id,
    action: "impersonate.start",
    targetType: "Clinic",
    targetId: clinic.id,
  });

  return NextResponse.json({ ok: true, clinicId: clinic.id });
}
