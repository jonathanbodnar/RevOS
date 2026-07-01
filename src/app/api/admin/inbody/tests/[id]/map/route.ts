import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperAdminClinicApi } from "@/lib/api-guard";
import { prisma } from "@/lib/prisma";
import { refetchInBodyTest } from "@/lib/inbody-ingest";

export const dynamic = "force-dynamic";

const Body = z.object({
  // null / empty string unmaps (clears the pairing).
  customerId: z.string().nullable().optional(),
});

/** Manually map (or unmap) an InBody test to a RevOS customer. */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = await requireSuperAdminClinicApi();
  if ("error" in guard) return guard.error;
  const { id } = await params;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  }
  const customerId = parsed.data.customerId || null;

  const test = await prisma.inBodyTest.findUnique({ where: { id } });
  if (!test) return NextResponse.json({ error: "Test not found" }, { status: 404 });

  if (!customerId) {
    await prisma.inBodyTest.update({
      where: { id },
      data: { customerId: null, clinicId: null, matchStatus: "unmatched" },
    });
    return NextResponse.json({ ok: true, matched: false });
  }

  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { id: true, clinicId: true },
  });
  if (!customer) {
    return NextResponse.json({ error: "Customer not found" }, { status: 404 });
  }

  await prisma.inBodyTest.update({
    where: { id },
    data: {
      customerId: customer.id,
      clinicId: customer.clinicId,
      matchStatus: "manual",
    },
  });

  // Best-effort: try to pull the metrics now that we know the customer.
  await refetchInBodyTest(id).catch(() => null);

  return NextResponse.json({ ok: true, matched: true });
}
