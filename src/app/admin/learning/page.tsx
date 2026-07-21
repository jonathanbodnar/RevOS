import { requireSuperAdmin } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { LearningAdmin } from "./learning-admin";

export const dynamic = "force-dynamic";

export default async function AdminLearningPage() {
  await requireSuperAdmin();
  const modules = await prisma.learningModule.findMany({
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      title: true,
      summary: true,
      bodyHtml: true,
      videoUrl: true,
      category: true,
      audience: true,
      publishedAt: true,
      _count: { select: { progress: { where: { status: "completed" } } } },
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Training</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Author training modules for clinic admins and providers. Markdown is
          supported; content is sanitized on render.
        </p>
      </div>
      <LearningAdmin
        modules={modules.map((m) => ({
          id: m.id,
          title: m.title,
          summary: m.summary,
          bodyMarkdown: m.bodyHtml ?? "",
          videoUrl: m.videoUrl,
          category: m.category,
          audience: m.audience,
          published: !!m.publishedAt,
          completions: m._count.progress,
        }))}
      />
    </div>
  );
}
