import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
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

  const implementors = await prisma.implementor.findMany({
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    include: { _count: { select: { customers: true } } },
  });
  return NextResponse.json({ data: implementors });
}

const PostBody = z.object({
  name: z.string().min(1).max(120),
  commissionCents: z.coerce.number().int().min(0).optional(),
});

export async function POST(req: Request) {
  const session = await guard();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const parsed = PostBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const existing = await prisma.implementor.findFirst({
    where: { name: { equals: parsed.data.name.trim(), mode: "insensitive" } },
  });
  if (existing) {
    return NextResponse.json(
      { error: "An implementor with that name already exists." },
      { status: 409 },
    );
  }

  const created = await prisma.implementor.create({
    data: {
      name: parsed.data.name.trim(),
      ...(parsed.data.commissionCents !== undefined
        ? { commissionCents: parsed.data.commissionCents }
        : {}),
    },
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: "SUPER_ADMIN",
    clinicId: null,
    action: "implementor.create",
    targetType: "Implementor",
    targetId: created.id,
    metadata: { name: created.name },
  });

  return NextResponse.json({ data: created }, { status: 201 });
}
