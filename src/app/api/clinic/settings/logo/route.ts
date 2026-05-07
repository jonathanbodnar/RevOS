import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

const Body = z.object({
  logo: z.string().min(1),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (!session?.user?.clinicId) {
    return NextResponse.json({ error: "No clinic context" }, { status: 400 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const clinic = await prisma.clinic.update({
    where: { id: session.user.clinicId },
    data: { logoUrl: parsed.data.logo },
    select: { id: true, logoUrl: true },
  });

  return NextResponse.json(clinic);
}

export async function DELETE() {
  const session = await getSession();
  if (!session?.user?.clinicId) {
    return NextResponse.json({ error: "No clinic context" }, { status: 400 });
  }

  const clinic = await prisma.clinic.update({
    where: { id: session.user.clinicId },
    data: { logoUrl: null },
    select: { id: true, logoUrl: true },
  });

  return NextResponse.json(clinic);
}
