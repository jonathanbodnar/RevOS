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

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 80);
}

const Body = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().max(500).optional(),
  bodyMarkdown: z.string().max(50000).optional(),
  videoUrl: z.string().max(500).optional(),
  category: z.string().max(80).optional(),
  audience: z.enum(["BOTH", "CLINIC_ADMIN", "PROVIDER"]).default("BOTH"),
  publish: z.boolean().default(false),
});

export async function POST(req: Request) {
  const session = await guard();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const d = parsed.data;
  // Unique slug (append a short suffix on collision).
  let slug = slugify(d.title) || "module";
  if (await prisma.learningModule.findUnique({ where: { slug } })) {
    slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
  }
  const last = await prisma.learningModule.findFirst({
    orderBy: { position: "desc" },
    select: { position: true },
  });

  const module = await prisma.learningModule.create({
    data: {
      slug,
      title: d.title,
      summary: d.summary || null,
      bodyHtml: d.bodyMarkdown || null, // stored as markdown; rendered safely on read
      videoUrl: d.videoUrl || null,
      category: d.category || null,
      audience: d.audience,
      position: (last?.position ?? 0) + 1,
      publishedAt: d.publish ? new Date() : null,
      createdById: session.user.id,
    },
    select: { id: true, slug: true },
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId: null,
    action: "learning_module.create",
    targetType: "LearningModule",
    targetId: module.id,
    metadata: { published: d.publish },
  });

  return NextResponse.json({ data: module }, { status: 201 });
}
