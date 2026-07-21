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

export async function GET() {
  const session = await guard();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const kpis = await prisma.kPI.findMany({
    orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
    include: {
      clinic: { select: { name: true } },
      _count: { select: { flags: { where: { status: "open" } } } },
    },
  });
  return NextResponse.json({ data: kpis });
}

const Body = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().max(500).optional(),
  metric: z.enum([
    "visit_adherence_pct",
    "days_since_last_charge",
    "weeks_since_last_scan",
    "body_fat_pct_change",
    "weight_change_kg",
  ]),
  comparison: z.enum(["gt", "gte", "lt", "lte"]),
  threshold: z.coerce.number(),
  windowDays: z.coerce.number().int().min(0).max(3650).default(0),
  severity: z.enum(["info", "warn", "critical"]).default("warn"),
  clinicId: z.string().optional().nullable(),
});

export async function POST(req: Request) {
  const session = await guard();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const d = parsed.data;
  const kpi = await prisma.kPI.create({
    data: {
      name: d.name,
      description: d.description || null,
      metric: d.metric,
      comparison: d.comparison,
      threshold: d.threshold,
      windowDays: d.windowDays,
      severity: d.severity,
      clinicId: d.clinicId || null,
      createdById: session.user.id,
    },
    select: { id: true },
  });
  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId: d.clinicId || null,
    action: "kpi.create",
    targetType: "KPI",
    targetId: kpi.id,
    metadata: { metric: d.metric, comparison: d.comparison, threshold: d.threshold },
  });
  return NextResponse.json({ data: kpi }, { status: 201 });
}
