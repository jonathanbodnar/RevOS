import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { hashPassword } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

async function guard() {
  const session = await getSession();
  if (session?.user?.originalRole !== "SUPER_ADMIN") return null;
  return session;
}

export async function GET() {
  const session = await guard();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const users = await prisma.user.findMany({
    orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      clinicId: true,
      clinic: { select: { name: true } },
      _count: { select: { providerAssignments: true } },
    },
  });
  return NextResponse.json({ data: users });
}

const PostBody = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(200),
  password: z.string().min(8).max(200),
  role: z.enum(["CLINIC_ADMIN", "PROVIDER", "BILLING_DEPT"]),
  clinicId: z.string().optional().nullable(),
});

export async function POST(req: Request) {
  const session = await guard();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const parsed = PostBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const { name, email, password, role, clinicId } = parsed.data;

  // Clinic-scoped roles need a clinic; billing is cross-clinic.
  const needsClinic = role === "CLINIC_ADMIN" || role === "PROVIDER";
  if (needsClinic && !clinicId) {
    return NextResponse.json(
      { error: "Select a clinic for this role." },
      { status: 400 },
    );
  }
  if (needsClinic) {
    const clinic = await prisma.clinic.findUnique({ where: { id: clinicId! } });
    if (!clinic) {
      return NextResponse.json({ error: "Clinic not found" }, { status: 404 });
    }
  }

  const existing = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
  });
  if (existing) {
    return NextResponse.json(
      { error: "A user with that email already exists." },
      { status: 409 },
    );
  }

  const user = await prisma.user.create({
    data: {
      name,
      email: email.toLowerCase(),
      passwordHash: await hashPassword(password),
      role,
      clinicId: needsClinic ? clinicId! : null,
    },
    select: { id: true, email: true, role: true },
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId: needsClinic ? clinicId! : null,
    action: "user.create",
    targetType: "User",
    targetId: user.id,
    metadata: { role, email: user.email },
  });

  return NextResponse.json({ data: user }, { status: 201 });
}
