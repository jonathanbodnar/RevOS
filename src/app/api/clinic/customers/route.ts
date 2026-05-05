import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { logAudit } from "@/lib/audit";

const Body = z.object({
  firstName: z.string().max(80).optional().default(""),
  lastName: z.string().max(80).optional().default(""),
  email: z.string().email().optional().or(z.literal("")).default(""),
  phone: z.string().max(40).optional().default(""),
  address: z.string().max(200).optional().default(""),
  city: z.string().max(80).optional().default(""),
  state: z.string().max(80).optional().default(""),
  zip: z.string().max(20).optional().default(""),
});

export async function POST(req: Request) {
  const guard = await requireClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid input", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const d = parsed.data;

  // Create on LunarPay first so we get the canonical id. LunarPay does an
  // email upsert globally under our single merchant — so two clinics sharing
  // the same customer email will point to the same LunarPay customer id.
  // That's intentional (they're really the same person/card) but the charge
  // description below always carries the clinic context for auditability.
  let lpCustomerId: number | null = null;
  try {
    if (d.email || d.firstName || d.lastName) {
      const lp = await lunarpay.createCustomer({
        firstName: d.firstName || undefined,
        lastName: d.lastName || undefined,
        email: d.email || undefined,
        phone: d.phone || undefined,
        address: d.address || undefined,
        city: d.city || undefined,
        state: d.state || undefined,
        zip: d.zip || undefined,
      });
      lpCustomerId = lp.data.id;
    }
  } catch (e) {
    const status = e instanceof LunarPayError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "LunarPay error";
    return NextResponse.json({ error: `LunarPay: ${msg}` }, { status });
  }

  // If the same LP customer id already exists on a local record for this
  // clinic, don't duplicate.
  if (lpCustomerId) {
    const existing = await prisma.customer.findFirst({
      where: { clinicId, lunarpayCustomerId: lpCustomerId },
    });
    if (existing) {
      return NextResponse.json({ data: { id: existing.id } }, { status: 200 });
    }
  }

  const customer = await prisma.customer.create({
    data: {
      clinicId,
      lunarpayCustomerId: lpCustomerId ?? undefined,
      firstName: d.firstName || null,
      lastName: d.lastName || null,
      email: d.email || null,
      phone: d.phone || null,
      address: d.address || null,
      city: d.city || null,
      state: d.state || null,
      zip: d.zip || null,
    },
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId,
    action: "customer.create",
    targetType: "Customer",
    targetId: customer.id,
    metadata: { lunarpayCustomerId: lpCustomerId },
  });

  return NextResponse.json({ data: { id: customer.id } }, { status: 201 });
}
