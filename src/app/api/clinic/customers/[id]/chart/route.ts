import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { requireStringParams } from "@/lib/route-params";
import { logAudit } from "@/lib/audit";

/**
 * Program chart — the weekly adherence grid on a customer profile.
 *
 * Two shapes on one route:
 *   { signedDate: "YYYY-MM-DD" | null }              → set the program anchor
 *   { weekNumber, scheduled?, completed?, notes? }   → upsert one week's cell
 *
 * Clinic-scoped (any clinic user in context). When the Provider role lands,
 * this guard tightens to the caller's assigned customers; the write shape
 * doesn't change. Every edit is audit-logged (the chart's version trail).
 */
const Body = z.union([
  z.object({
    signedDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date")
      .nullable(),
  }),
  z.object({
    weekNumber: z.coerce.number().int().min(1).max(520),
    scheduled: z.boolean().optional(),
    completed: z.boolean().optional(),
    notes: z.string().max(5000).optional(),
  }),
]);

export async function PUT(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const guard = await requireClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;

  const params = await requireStringParams(ctx.params, ["id"] as const);
  if (!params.ok) return params.response;
  const { id } = params.value;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const customer = await prisma.customer.findFirst({
    where: { id, clinicId },
    select: { id: true, clinicId: true },
  });
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  // ── Set the program anchor date ──
  if ("signedDate" in parsed.data) {
    const signedOn = parsed.data.signedDate
      ? new Date(`${parsed.data.signedDate}T00:00:00.000Z`)
      : null;
    await prisma.customer.update({
      where: { id: customer.id },
      data: { programSignedOn: signedOn },
    });
    await logAudit({
      actorId: session.user.id,
      actorRole: session.user.originalRole,
      clinicId,
      action: "chart.signed_date.set",
      targetType: "Customer",
      targetId: customer.id,
      metadata: { signedDate: parsed.data.signedDate },
    });
    return NextResponse.json({ data: { signedDate: parsed.data.signedDate } });
  }

  // ── Upsert one week's cell ──
  const { weekNumber, scheduled, completed, notes } = parsed.data;
  // Normalize blank/whitespace notes to null so they never count as "has a
  // note" downstream.
  const cleanNotes = notes !== undefined ? notes.trim() || null : undefined;
  const row = await prisma.chartWeek.upsert({
    where: { customerId_weekNumber: { customerId: customer.id, weekNumber } },
    create: {
      customerId: customer.id,
      clinicId,
      weekNumber,
      scheduled: scheduled ?? false,
      completed: completed ?? false,
      progressNotes: cleanNotes ?? null,
      updatedById: session.user.id,
    },
    update: {
      ...(scheduled !== undefined ? { scheduled } : {}),
      ...(completed !== undefined ? { completed } : {}),
      ...(cleanNotes !== undefined ? { progressNotes: cleanNotes } : {}),
      updatedById: session.user.id,
    },
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId,
    action: "chart.week.update",
    targetType: "ChartWeek",
    targetId: row.id,
    metadata: {
      customerId: customer.id,
      weekNumber,
      scheduled: row.scheduled,
      completed: row.completed,
      hasNotes: !!row.progressNotes,
    },
  });

  return NextResponse.json({
    data: {
      weekNumber: row.weekNumber,
      scheduled: row.scheduled,
      completed: row.completed,
      notes: row.progressNotes,
    },
  });
}
