import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperAdminApi } from "@/lib/api-guard";
import { logAudit } from "@/lib/audit";
import { backfillInBodyTests } from "@/lib/inbody-ingest";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const Body = z.object({ limit: z.number().int().min(1).max(500).optional() });

/** Re-fetch historical InBody rows that do not yet have measurements. */
export async function POST(req: Request) {
  const guard = await requireSuperAdminApi();
  if ("error" in guard) return guard.error;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }

  const summary = await backfillInBodyTests(parsed.data.limit);
  await logAudit({
    actorId: guard.session.user.id ?? null,
    actorRole: guard.session.user.originalRole,
    action: "inbody.backfill",
    targetType: "InBodyTest",
    targetId: "PENDING",
    metadata: {
      scanned: summary.scanned,
      fetched: summary.fetched,
      mapped: summary.mapped,
      errorCount: summary.errors.length,
    },
  });

  return NextResponse.json(summary);
}
