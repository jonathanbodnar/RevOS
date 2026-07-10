import { NextRequest, NextResponse } from "next/server";
import { requireSuperAdminApi } from "@/lib/api-guard";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/** Lightweight customer search (name / email / phone) across all clinics. */
export async function GET(req: NextRequest) {
  const guard = await requireSuperAdminApi();
  if ("error" in guard) return guard.error;

  const q = (req.nextUrl.searchParams.get("q") || "").trim();
  if (q.length < 2) return NextResponse.json({ results: [] });

  const includeInactive =
    req.nextUrl.searchParams.get("includeInactive") === "1";
  const digits = q.replace(/\D+/g, "");

  const customers = await prisma.customer.findMany({
    where: {
      ...(includeInactive ? {} : { isActive: true }),
      OR: [
        { firstName: { contains: q, mode: "insensitive" } },
        { lastName: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
        ...(digits.length >= 3 ? [{ phone: { contains: digits } }] : []),
      ],
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      isActive: true,
      clinicId: true,
      clinic: { select: { name: true } },
    },
    take: 40,
  });

  return NextResponse.json({
    results: customers.map((c) => ({
      id: c.id,
      label:
        [c.firstName, c.lastName].filter(Boolean).join(" ").trim() ||
        c.email ||
        c.id,
      email: c.email,
      phone: c.phone,
      clinic: c.clinic?.name ?? null,
      clinicId: c.clinicId,
      isActive: c.isActive,
    })),
  });
}
