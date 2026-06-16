import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { logAudit } from "@/lib/audit";
import { parseMoneyInputToCents } from "@/lib/format";

export const dynamic = "force-dynamic";

async function guard() {
  const session = await getSession();
  if (session?.user?.originalRole !== "SUPER_ADMIN") return null;
  return session;
}

const PostBody = z.object({
  clinicId: z.string().min(1),
  amount: z.string().min(1),
  paidOn: z.string().optional(), // YYYY-MM-DD
  note: z.string().max(300).optional(),
});

export async function POST(req: Request) {
  const session = await guard();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const parsed = PostBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const cents = parseMoneyInputToCents(parsed.data.amount);
  if (cents === null || cents <= 0) {
    return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
  }

  const created = await prisma.clinicPayout.create({
    data: {
      clinicId: parsed.data.clinicId,
      amountCents: cents,
      paidOn: parsed.data.paidOn
        ? new Date(`${parsed.data.paidOn}T12:00:00Z`)
        : new Date(),
      note: parsed.data.note?.trim() || null,
      createdById: session.user.id,
    },
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: "SUPER_ADMIN",
    clinicId: parsed.data.clinicId,
    action: "clinic_payout.create",
    targetType: "ClinicPayout",
    targetId: created.id,
    metadata: { amountCents: cents },
  });

  return NextResponse.json({ data: { id: created.id } }, { status: 201 });
}
