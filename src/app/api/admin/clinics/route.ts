import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { hashPassword } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { slugify } from "@/lib/format";

const Body = z.object({
  name: z.string().min(2).max(100),
  slug: z.string().max(50).optional().default(""),
  contactEmail: z
    .string()
    .email()
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : undefined)),
  adminName: z.string().min(1).max(120),
  adminEmail: z.string().email(),
  adminPassword: z.string().min(8).max(128),
});

export async function POST(req: Request) {
  const session = await getSession();
  if (session?.user?.originalRole !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const data = parsed.data;
  const desiredSlug = (data.slug || slugify(data.name)) || "clinic";

  try {
    const slug = await uniqueSlug(desiredSlug);
    const passwordHash = await hashPassword(data.adminPassword);
    const result = await prisma.$transaction(async (tx) => {
      const clinic = await tx.clinic.create({
        data: {
          name: data.name,
          slug,
          email: data.contactEmail,
        },
      });
      const existing = await tx.user.findUnique({
        where: { email: data.adminEmail.toLowerCase() },
      });
      if (existing) {
        throw new Error("A user with that email already exists.");
      }
      await tx.user.create({
        data: {
          email: data.adminEmail.toLowerCase(),
          passwordHash,
          name: data.adminName,
          role: "CLINIC_ADMIN",
          clinicId: clinic.id,
        },
      });
      return clinic;
    });

    await logAudit({
      actorId: session.user.id,
      actorRole: session.user.originalRole,
      clinicId: result.id,
      action: "clinic.create",
      targetType: "Clinic",
      targetId: result.id,
      metadata: { name: result.name, slug: result.slug },
    });
    return NextResponse.json({ data: result }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to create clinic";
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}

async function uniqueSlug(base: string): Promise<string> {
  let slug = base;
  let i = 1;
  // Bounded loop to avoid surprises.
  while (i < 50) {
    const exists = await prisma.clinic.findUnique({ where: { slug } });
    if (!exists) return slug;
    slug = `${base}-${i++}`;
  }
  return `${base}-${Date.now()}`;
}
