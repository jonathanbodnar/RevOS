import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperAdminApi } from "@/lib/api-guard";
import { prisma } from "@/lib/prisma";
import {
  refetchInBodyTest,
  backfillCustomerScansFromInBody,
  refetchMissingScansForCustomer,
} from "@/lib/inbody-ingest";
import { logAudit } from "@/lib/audit";

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
  const guard = await requireSuperAdminApi();
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
    await logAudit({
      actorId: guard.session.user.id ?? null,
      actorRole: guard.session.user.originalRole,
      clinicId: test.clinicId,
      action: "inbody.unmap",
      targetType: "InBodyTest",
      targetId: test.id,
      metadata: { previousCustomerId: test.customerId },
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
  if (!customer.clinicId) {
    return NextResponse.json({ error: "Customer is not assigned to a clinic" }, { status: 400 });
  }

  await prisma.inBodyTest.update({
    where: { id },
    data: {
      customerId: customer.id,
      clinicId: customer.clinicId,
      matchStatus: "manual",
    },
  });

  // Best-effort: pull this scan's metrics, then the rest of the patient's
  // LookinBody history — mapping by hand is the same moment of "we now know
  // who this is" as an automatic pairing.
  await refetchInBodyTest(id).catch(() => null);
  await backfillCustomerScansFromInBody(customer.id).catch(() => null);
  await refetchMissingScansForCustomer(customer.id).catch(() => null);

  await logAudit({
    actorId: guard.session.user.id ?? null,
    actorRole: guard.session.user.originalRole,
    clinicId: customer.clinicId,
    action: "inbody.map",
    targetType: "InBodyTest",
    targetId: test.id,
    metadata: { customerId: customer.id, previousCustomerId: test.customerId },
  });

  return NextResponse.json({ ok: true, matched: true });
}
