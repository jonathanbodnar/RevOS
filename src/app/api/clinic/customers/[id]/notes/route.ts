import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { requireStringParams } from "@/lib/route-params";
import { logAudit } from "@/lib/audit";
import { customerScopeWhere } from "@/lib/roles";
import { encryptField } from "@/lib/encryption";
import { NOTE_MAX_LENGTH, toNoteViews } from "@/lib/customer-notes";

/**
 * Add a note to a customer's Notes feed.
 *
 * Anyone who can open the profile may write one — providers only on their
 * assigned patients (customerScopeWhere), the same reach as the program chart.
 * The text is PHI: it is encrypted at rest and kept out of the audit log,
 * which records only that a note was added.
 */
const Body = z.object({
  body: z.string().trim().min(1).max(NOTE_MAX_LENGTH),
});

export async function POST(
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
    return NextResponse.json(
      {
        error: `Write a note of up to ${NOTE_MAX_LENGTH.toLocaleString("en-US")} characters.`,
      },
      { status: 400 },
    );
  }

  const customer = await prisma.customer.findFirst({
    where: { id, ...customerScopeWhere(session.user, clinicId) },
    select: { id: true },
  });
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  const note = await prisma.customerNote.create({
    data: {
      clinicId,
      customerId: customer.id,
      // Non-empty input always encrypts to a string.
      body: encryptField(parsed.data.body) as string,
      authorId: session.user.id,
    },
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId,
    action: "customer_note.create",
    targetType: "CustomerNote",
    targetId: note.id,
    metadata: { customerId: customer.id },
  });

  const [view] = await toNoteViews([note], session.user);
  return NextResponse.json({ data: view }, { status: 201 });
}
