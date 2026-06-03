import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

async function guard() {
  const session = await getSession();
  if (session?.user?.originalRole !== "SUPER_ADMIN") return null;
  return session;
}

export async function GET() {
  const session = await guard();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const reports = await prisma.savedReport.findMany({
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ data: reports });
}

const PostBody = z.object({
  name: z.string().min(1).max(120),
  filtersJson: z.string().min(2),
  snapshotJson: z.string().optional(),
});

export async function POST(req: Request) {
  const session = await guard();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const parsed = PostBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const created = await prisma.savedReport.create({
    data: {
      name: parsed.data.name,
      filtersJson: parsed.data.filtersJson,
      snapshotJson: parsed.data.snapshotJson ?? null,
      createdById: session.user.id,
    },
  });

  return NextResponse.json({ data: created }, { status: 201 });
}
