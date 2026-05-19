import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { hashPassword } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// Edit fields are all individually optional — the UI sends just the
// fields that changed (e.g. only `password` when resetting a password).
const PatchBody = z.object({
  name: z.string().min(1).max(120).optional(),
  email: z.string().email().optional(),
  password: z.string().min(8).max(128).optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;
  const { id } = await params;

  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // Find the target user, scoped to this clinic so a clinic admin can
  // only ever edit their own clinic's team members.
  const member = await prisma.user.findFirst({
    where: { id, clinicId, role: "CLINIC_ADMIN" },
  });
  if (!member) {
    return NextResponse.json({ error: "Team member not found" }, { status: 404 });
  }

  const data: {
    name?: string;
    email?: string;
    passwordHash?: string;
  } = {};
  if (parsed.data.name !== undefined) data.name = parsed.data.name;
  if (parsed.data.email !== undefined) {
    const normalizedEmail = parsed.data.email.toLowerCase();
    if (normalizedEmail !== member.email) {
      const clash = await prisma.user.findUnique({
        where: { email: normalizedEmail },
      });
      if (clash) {
        return NextResponse.json(
          { error: "A user with that email already exists." },
          { status: 400 },
        );
      }
      data.email = normalizedEmail;
    }
  }
  if (parsed.data.password !== undefined) {
    data.passwordHash = await hashPassword(parsed.data.password);
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ ok: true, member }, { status: 200 });
  }

  const updated = await prisma.user.update({
    where: { id },
    data,
    select: {
      id: true,
      name: true,
      email: true,
      isActive: true,
      createdAt: true,
    },
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId,
    action: "team.member.update",
    targetType: "User",
    targetId: id,
    metadata: {
      // never log the actual password, only that it was reset
      changedFields: Object.keys(parsed.data),
      passwordReset: parsed.data.password !== undefined,
    },
  });

  return NextResponse.json({ ok: true, member: updated });
}

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
