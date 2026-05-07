import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { logAudit } from "@/lib/audit";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;

  const { id } = await params;

  if (id === session.user.id) {
    return NextResponse.json(
      { error: "You cannot remove yourself." },
      { status: 400 },
    );
  }

  const member = await prisma.user.findFirst({
    where: { id, clinicId, role: "CLINIC_ADMIN" },
  });
  if (!member) {
    return NextResponse.json({ error: "Team member not found" }, { status: 404 });
  }

  await prisma.user.update({
    where: { id },
    data: { isActive: false },
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId,
    action: "team.member.remove",
    targetType: "User",
    targetId: id,
    metadata: { email: member.email, name: member.name },
  });

  return NextResponse.json({ success: true });
}
