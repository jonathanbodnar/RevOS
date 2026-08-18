import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperAdminApi } from "@/lib/api-guard";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const Body = z.object({
  dismissed: z.boolean().default(true),
  reason: z.string().trim().max(200).optional(),
});

/**
 * Retire an InBody test from the mapping queue (or put it back).
 *
 * A soft flag, never a delete: the row is evidence that a real scan happened,
 * and a delete wouldn't stick anyway — ingest upserts on `dedupeKey`, so the
 * next webhook re-delivery or "Pull today's data" sync would recreate it and
 * the dismissal would silently undo itself.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireSuperAdminApi();
  if ("error" in guard) return guard.error;
  const { id } = await params;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const { dismissed, reason } = parsed.data;

  const test = await prisma.inBodyTest.findUnique({ where: { id } });
  if (!test) return NextResponse.json({ error: "Test not found" }, { status: 404 });

  await prisma.inBodyTest.update({
    where: { id },
    data: dismissed
      ? {
          dismissedAt: new Date(),
          dismissedById: guard.session.user.id ?? null,
          dismissedReason: reason || null,
        }
      : { dismissedAt: null, dismissedById: null, dismissedReason: null },
  });

  await logAudit({
    actorId: guard.session.user.id ?? null,
    actorRole: guard.session.user.originalRole,
    clinicId: test.clinicId,
    action: dismissed ? "inbody.dismiss" : "inbody.undismiss",
    targetType: "InBodyTest",
    targetId: test.id,
    metadata: { reason: reason || null },
  });

  return NextResponse.json({ ok: true, dismissed });
}
