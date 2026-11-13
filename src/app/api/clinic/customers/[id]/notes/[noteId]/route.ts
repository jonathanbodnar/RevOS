import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { requireStringParams } from "@/lib/route-params";
import { logAudit } from "@/lib/audit";
import { customerScopeWhere } from "@/lib/roles";
import { canRemoveNote } from "@/lib/customer-notes";

/**
 * Remove a note from a customer's Notes feed — a soft delete.
 *
 * Only the person who wrote the note, or a super admin, may remove it. The row
 * is kept (deletedAt / deletedById say who took it down and when) so the
 * clinical record stays intact; it just stops appearing in the feed.
 */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string; noteId: string }> },
) {
  const guard = await requireClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;

  const params = await requireStringParams(ctx.params, ["id", "noteId"] as const);
  if (!params.ok) return params.response;
  const { id, noteId } = params.value;

  const customer = await prisma.customer.findFirst({
    where: { id, ...customerScopeWhere(session.user, clinicId) },
    select: { id: true },
  });
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  const note = await prisma.customerNote.findFirst({
    where: { id: noteId, customerId: customer.id, deletedAt: null },
    select: { id: true, authorId: true },
  });
  if (!note) {
    return NextResponse.json({ error: "Note not found" }, { status: 404 });
  }
  if (!canRemoveNote(note, session.user)) {
    return NextResponse.json(
      { error: "Only the person who wrote this note, or a super admin, can remove it." },
      { status: 403 },
    );
  }

  await prisma.customerNote.update({
    where: { id: note.id },
    data: { deletedAt: new Date(), deletedById: session.user.id },
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId,
    action: "customer_note.delete",
    targetType: "CustomerNote",
    targetId: note.id,
    metadata: { customerId: customer.id },
  });

  return NextResponse.json({ ok: true });
}
