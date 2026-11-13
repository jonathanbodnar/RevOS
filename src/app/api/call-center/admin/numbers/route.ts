import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { requireCallCenterAdminApi } from "@/lib/call-center/access";
import { attachExistingNumber, buyClinicNumber, searchClinicNumbers } from "@/lib/call-center/phone-setup";
import { TelnyxError } from "@/lib/call-center/telnyx";

export const dynamic = "force-dynamic";

function telnyxFail(e: unknown) {
  if (e instanceof TelnyxError) return NextResponse.json({ error: e.message }, { status: e.status >= 500 ? 502 : e.status });
  throw e;
}

/** Search available local numbers (by area code, state or city). */
export async function GET(req: Request) {
  const g = await requireCallCenterAdminApi();
  if ("error" in g) return g.error;
  const sp = new URL(req.url).searchParams;
  const areaCode = (sp.get("areaCode") || "").replace(/\D/g, "").slice(0, 3);
  const state = (sp.get("state") || "").trim().slice(0, 2).toUpperCase();
  const city = (sp.get("city") || "").trim().slice(0, 60);
  if (!areaCode && !state && !city) return NextResponse.json({ error: "Enter an area code, state or city." }, { status: 400 });
  try {
    return NextResponse.json({ data: await searchClinicNumbers({ areaCode: areaCode || undefined, state: state || undefined, city: city || undefined }) });
  } catch (e) {
    return telnyxFail(e);
  }
}

const Body = z.object({
  clinicId: z.string().min(10).max(40),
  phoneNumber: z.string().trim().regex(/^\+?1?\d{10}$/),
  mode: z.enum(["buy", "attach"]),
});

/** Buy a number for a clinic (spends money), or attach one already in the Telnyx account. */
export async function POST(req: Request) {
  const g = await requireCallCenterAdminApi();
  if ("error" in g) return g.error;
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const clinic = await prisma.clinic.findUnique({ where: { id: parsed.data.clinicId }, select: { id: true } });
  if (!clinic) return NextResponse.json({ error: "Clinic not found" }, { status: 404 });
  const dup = await prisma.clinicPhoneNumber.findFirst({ where: { e164: { endsWith: parsed.data.phoneNumber.replace(/\D/g, "").slice(-10) } } });
  if (dup) return NextResponse.json({ error: "That number is already assigned to a clinic." }, { status: 409 });
  try {
    const row =
      parsed.data.mode === "buy"
        ? await buyClinicNumber(clinic.id, parsed.data.phoneNumber)
        : await attachExistingNumber(clinic.id, parsed.data.phoneNumber);
    await logAudit({
      actorId: g.session.user.id,
      actorRole: g.session.user.originalRole,
      clinicId: clinic.id,
      action: parsed.data.mode === "buy" ? "telnyx.number_buy" : "telnyx.number_attach",
      targetType: "ClinicPhoneNumber",
      targetId: row.id,
      metadata: { number: row.e164 },
    });
    return NextResponse.json({ data: row }, { status: 201 });
  } catch (e) {
    return telnyxFail(e);
  }
}
