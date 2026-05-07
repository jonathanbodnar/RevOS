import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { hashPassword } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

const Body = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(8).max(128),
});

export async function GET() {
  const guard = await requireClinicApi();
  if ("error" in guard) return guard.error;
  const { clinicId } = guard;

  const members = await prisma.user.findMany({
    where: { clinicId, role: "CLINIC_ADMIN" },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      isActive: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ members });
}

export async function POST(req: Request) {
  const guard = await requireClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const existing = await prisma.user.findUnique({
    where: { email: parsed.data.email.toLowerCase() },
  });
  if (existing) {
    return NextResponse.json(
      { error: "A user with that email already exists." },
      { status: 400 },
    );
  }

  const passwordHash = await hashPassword(parsed.data.password);
  const member = await prisma.user.create({
    data: {
      email: parsed.data.email.toLowerCase(),
      passwordHash,
      name: parsed.data.name,
      role: "CLINIC_ADMIN",
      clinicId,
    },
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
    action: "team.member.add",
    targetType: "User",
    targetId: member.id,
    metadata: { email: member.email, name: member.name },
  });

  return NextResponse.json({ member }, { status: 201 });
}
