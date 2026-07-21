import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const Body = z.object({
  moduleId: z.string().min(1),
  status: z.enum(["in_progress", "completed"]),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const { moduleId, status } = parsed.data;

  const mod = await prisma.learningModule.findFirst({
    where: { id: moduleId, publishedAt: { not: null } },
    select: { id: true },
  });
  if (!mod) {
    return NextResponse.json({ error: "Module not found" }, { status: 404 });
  }

  const progress = await prisma.learningProgress.upsert({
    where: { userId_moduleId: { userId: session.user.id, moduleId } },
    create: {
      userId: session.user.id,
      moduleId,
      status,
      completedAt: status === "completed" ? new Date() : null,
    },
    update: {
      status,
      completedAt: status === "completed" ? new Date() : null,
    },
    select: { status: true },
  });

  return NextResponse.json({ data: progress });
}
