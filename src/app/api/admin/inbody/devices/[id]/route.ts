import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperAdminApi } from "@/lib/api-guard";
import { requireStringParams } from "@/lib/route-params";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

const Body = z.object({
  clinicId: z.string().nullable(),
  label: z.string().trim().max(80).nullable().optional(),
  // Apply the clinic to this device's existing scans that have none yet.
  applyToExisting: z.boolean().optional(),
});

/** Assign an InBody unit to the clinic it physically sits in. */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const guard = await requireSuperAdminApi();
  if ("error" in guard) return guard.error;

  const params = await requireStringParams(ctx.params, ["id"] as const);
  if (!params.ok) return params.response;
  const { id } = params.value;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }
  const { clinicId, label, applyToExisting } = parsed.data;

  const device = await prisma.inBodyDevice.findUnique({ where: { id } });
  if (!device) {
    return NextResponse.json({ error: "Device not found" }, { status: 404 });
  }
  if (clinicId) {
    const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
    if (!clinic) {
      return NextResponse.json({ error: "Clinic not found" }, { status: 404 });
    }
  }

  await prisma.inBodyDevice.update({
    where: { id },
    data: { clinicId, ...(label !== undefined ? { label } : {}) },
  });

  // Only fills gaps: a scan already attributed through its patient keeps that
  // attribution, since the patient is the stronger signal.
  let updatedScans = 0;
  if (applyToExisting && clinicId) {
    const { count } = await prisma.inBodyTest.updateMany({
      where: { equipSerial: device.serial, clinicId: null },
      data: { clinicId },
    });
    updatedScans = count;
  }

  await logAudit({
    actorId: guard.session.user.id ?? null,
    actorRole: guard.session.user.originalRole,
    clinicId,
    action: "inbody.device.assign",
    targetType: "InBodyDevice",
    targetId: device.id,
    metadata: { serial: device.serial, clinicId, updatedScans },
  });

  return NextResponse.json({ ok: true, updatedScans });
}
