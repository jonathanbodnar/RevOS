import Link from "next/link";
import { notFound } from "next/navigation";
import { requireClinicContext } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { renderMarkdownSafe, safeVideoUrl } from "@/lib/markdown";
import { CompleteButton } from "./complete-button";

export const dynamic = "force-dynamic";

function allowedAudiences(role: string): string[] {
  if (role === "PROVIDER") return ["BOTH", "PROVIDER"];
  return ["BOTH", "CLINIC_ADMIN"];
}

export default async function ModulePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { session } = await requireClinicContext();

  const mod = await prisma.learningModule.findFirst({
    where: {
      id,
      publishedAt: { not: null },
      audience: { in: allowedAudiences(session.user.originalRole) },
    },
  });
  if (!mod) notFound();

  const progress = await prisma.learningProgress.findUnique({
    where: { userId_moduleId: { userId: session.user.id, moduleId: mod.id } },
    select: { status: true },
  });
  const done = progress?.status === "completed";
  const video = safeVideoUrl(mod.videoUrl);
  const html = mod.bodyHtml ? renderMarkdownSafe(mod.bodyHtml) : "";

  return (
    <div className="max-w-3xl space-y-5">
      <Link href="/clinic/learn" className="text-xs text-slate-500 hover:underline">
        ← All training
      </Link>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900">{mod.title}</h2>
          {mod.summary && (
            <p className="text-sm text-slate-500 mt-1">{mod.summary}</p>
          )}
        </div>
        <CompleteButton moduleId={mod.id} initialDone={done} />
      </div>

      {video && (
        <div className="aspect-video w-full overflow-hidden rounded-lg border border-line">
          <iframe
            src={video}
            className="w-full h-full"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            title={mod.title}
          />
        </div>
      )}

      {html ? (
        <article
          className="prose prose-slate max-w-none text-sm leading-relaxed [&_h1]:text-lg [&_h2]:text-base [&_h3]:text-sm [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:text-brand-600 [&_a]:underline [&_p]:my-2 [&_code]:bg-slate-100 [&_code]:px-1 [&_code]:rounded"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <p className="text-sm text-slate-400">No written content for this module.</p>
      )}
    </div>
  );
}
