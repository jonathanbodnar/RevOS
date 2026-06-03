import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { logAudit } from "@/lib/audit";

const PatchBody = z.object({
  name: z.string().min(1).max(100).optional(),
  logoUrl: z.string().nullable().optional(),
  revosDownPaymentSharePct: z.number().int().min(0).max(100).optional(),
  implementorFeeCents: z.number().int().min(0).optional(),
  revosRecurringShareCents: z.number().int().min(0).optional(),
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (session?.user?.originalRole !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const clinic = await prisma.clinic.findUnique({ where: { id } });
  if (!clinic) {
    return NextResponse.json({ error: "Clinic not found" }, { status: 404 });
  }

  const updated = await prisma.clinic.update({
    where: { id },
    data: parsed.data,
    select: { id: true, name: true, logoUrl: true },
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: "SUPER_ADMIN",
    clinicId: id,
    action: "clinic.update",
    targetType: "Clinic",
    targetId: id,
    metadata: { name: updated.name },
  });

  return NextResponse.json(updated);
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (session?.user?.originalRole !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  const clinic = await prisma.clinic.findUnique({ where: { id } });
  if (!clinic) {
    return NextResponse.json({ error: "Clinic not found" }, { status: 404 });
  }

  await prisma.clinic.delete({ where: { id } });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId: null,
    action: "clinic.delete",
    targetType: "Clinic",
    targetId: id,
    metadata: { name: clinic.name, slug: clinic.slug },
  });

  return NextResponse.json({ success: true });
}
