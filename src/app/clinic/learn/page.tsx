import Link from "next/link";
import { requireClinicContext } from "@/lib/session";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** Which module audiences this role may see. */
function audienceFilter(role: string): string[] {
  if (role === "PROVIDER") return ["BOTH", "PROVIDER"];
  return ["BOTH", "CLINIC_ADMIN"]; // clinic admin (and super admin impersonating)
}

export default async function LearnPage() {
  const { session } = await requireClinicContext();
  const audiences = audienceFilter(session.user.originalRole);

  const [modules, progress] = await Promise.all([
    prisma.learningModule.findMany({
      where: { publishedAt: { not: null }, audience: { in: audiences } },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      select: { id: true, title: true, summary: true, category: true },
    }),
    prisma.learningProgress.findMany({
      where: { userId: session.user.id },
      select: { moduleId: true, status: true },
    }),
  ]);
  const doneIds = new Set(
    progress.filter((p) => p.status === "completed").map((p) => p.moduleId),
  );

  // Group by category.
  const groups = new Map<string, typeof modules>();
  for (const m of modules) {
    const key = m.category || "General";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(m);
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Training</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          {modules.length} module{modules.length === 1 ? "" : "s"} ·{" "}
          {doneIds.size} completed
        </p>
      </div>

      {modules.length === 0 && (
        <div className="card-pad text-center text-slate-500 py-12 text-sm">
          No training modules published yet.
        </div>
      )}

      {[...groups.entries()].map(([category, mods]) => (
        <div key={category} className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-700">{category}</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {mods.map((m) => (
              <Link
                key={m.id}
                href={`/clinic/learn/${m.id}`}
                className="card-pad hover:ring-2 hover:ring-brand-900/10 transition"
              >
                <div className="flex items-start justify-between gap-2">
                  <h4 className="text-sm font-semibold text-slate-900">
                    {m.title}
                  </h4>
                  {doneIds.has(m.id) && (
                    <span className="badge-green text-[10px]">done</span>
                  )}
                </div>
                {m.summary && (
                  <p className="text-xs text-slate-500 mt-1">{m.summary}</p>
                )}
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
