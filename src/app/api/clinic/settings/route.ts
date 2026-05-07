import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";

const UpdateBody = z.object({
  name: z.string().min(1).max(100),
});

export async function PATCH(req: Request) {
  const session = await getSession();
  const clinicId = session?.user?.effectiveClinicId;
  if (!clinicId) {
    return NextResponse.json({ error: "No clinic context" }, { status: 400 });
  }

  const parsed = UpdateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const clinic = await prisma.clinic.update({
    where: { id: clinicId },
    data: { name: parsed.data.name },
    select: { id: true, name: true, logoUrl: true },
  });

  return NextResponse.json(clinic);
}
