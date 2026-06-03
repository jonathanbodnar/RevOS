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
  customerId: z.string().nullable().optional(),
  category: z.enum(["supplements", "booklets", "other"]),
  description: z.string().min(1).max(300),
  amount: z.string().min(1),
  incurredOn: z.string().optional(), // YYYY-MM-DD
});

export async function POST(req: Request) {
  const session = await guard();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const parsed = PostBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const cents = parseMoneyInputToCents(parsed.data.amount);
  if (cents === null || cents < 0) {
    return NextResponse.json({ error: "Invalid amount" }, { status: 400 });
  }

  const created = await prisma.advancedCost.create({
    data: {
      clinicId: parsed.data.clinicId,
      customerId: parsed.data.customerId || null,
      category: parsed.data.category,
      description: parsed.data.description,
      amountCents: cents,
      incurredOn: parsed.data.incurredOn
        ? new Date(parsed.data.incurredOn)
        : new Date(),
      createdById: session.user.id,
    },
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: "SUPER_ADMIN",
    clinicId: parsed.data.clinicId,
    action: "advanced_cost.create",
    targetType: "AdvancedCost",
    targetId: created.id,
    metadata: { category: created.category, amountCents: cents },
  });

  return NextResponse.json({ data: { id: created.id } }, { status: 201 });
}
