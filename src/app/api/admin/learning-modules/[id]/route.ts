import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { requireStringParams } from "@/lib/route-params";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

async function guard() {
  const session = await getSession();
  if (session?.user?.originalRole !== "SUPER_ADMIN") return null;
  return session;
}

const Patch = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  summary: z.string().max(500).nullable().optional(),
  bodyMarkdown: z.string().max(50000).nullable().optional(),
  videoUrl: z.string().max(500).nullable().optional(),
  category: z.string().max(80).nullable().optional(),
  audience: z.enum(["BOTH", "CLINIC_ADMIN", "PROVIDER"]).optional(),
  published: z.boolean().optional(),
});

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await guard();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const params = await requireStringParams(ctx.params, ["id"] as const);
  if (!params.ok) return params.response;
  const parsed = Patch.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const d = parsed.data;
  const mod = await prisma.learningModule.update({
    where: { id: params.value.id },
    data: {
      ...(d.title !== undefined ? { title: d.title } : {}),
      ...(d.summary !== undefined ? { summary: d.summary } : {}),
      ...(d.bodyMarkdown !== undefined ? { bodyHtml: d.bodyMarkdown } : {}),
      ...(d.videoUrl !== undefined ? { videoUrl: d.videoUrl } : {}),
      ...(d.category !== undefined ? { category: d.category } : {}),
      ...(d.audience !== undefined ? { audience: d.audience } : {}),
      ...(d.published !== undefined
        ? { publishedAt: d.published ? new Date() : null }
        : {}),
    },
    select: { id: true, publishedAt: true },
  });
  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId: null,
    action: "learning_module.update",
    targetType: "LearningModule",
    targetId: mod.id,
  });
  return NextResponse.json({ data: mod });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await guard();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const params = await requireStringParams(ctx.params, ["id"] as const);
  if (!params.ok) return params.response;
  await prisma.learningModule.delete({ where: { id: params.value.id } });
  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId: null,
    action: "learning_module.delete",
    targetType: "LearningModule",
    targetId: params.value.id,
  });
  return NextResponse.json({ ok: true });
}
