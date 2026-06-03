import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { logAudit } from "@/lib/audit";

async function guard() {
  const session = await getSession();
  if (session?.user?.originalRole !== "SUPER_ADMIN") return null;
  return session;
}

const PatchBody = z.object({
  name: z.string().min(1).max(120).optional(),
  commissionCents: z.coerce.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await guard();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await ctx.params;

  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const updated = await prisma.implementor.update({
    where: { id },
    data: parsed.data,
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: "SUPER_ADMIN",
    clinicId: null,
    action: "implementor.update",
    targetType: "Implementor",
    targetId: id,
    metadata: parsed.data,
  });

  return NextResponse.json({ data: updated });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const session = await guard();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await ctx.params;

  // Customers keep their history; the FK is ON DELETE SET NULL.
  await prisma.implementor.delete({ where: { id } });

  await logAudit({
    actorId: session.user.id,
    actorRole: "SUPER_ADMIN",
    clinicId: null,
    action: "implementor.delete",
    targetType: "Implementor",
    targetId: id,
  });

  return NextResponse.json({ ok: true });
}
