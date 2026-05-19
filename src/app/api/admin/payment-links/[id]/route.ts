import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { logAudit } from "@/lib/audit";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getSession();
  if (session?.user?.originalRole !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  const link = await prisma.checkoutSession.findUnique({ where: { id } });
  if (!link || !link.isGlobal) {
    return NextResponse.json({ error: "Link not found" }, { status: 404 });
  }

  await prisma.checkoutSession.delete({ where: { id } });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId: null,
    action: "payment_link.global.delete",
    targetType: "CheckoutSession",
    targetId: id,
    metadata: { description: link.description, mode: link.mode },
  });

  return NextResponse.json({ success: true });
}
