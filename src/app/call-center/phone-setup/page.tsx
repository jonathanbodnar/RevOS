import { redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireCallCenterPage } from "@/lib/call-center/access";
import { getSetup } from "@/lib/call-center/dialer";
import { PhoneSetupClient } from "./phone-setup-client";

export const dynamic = "force-dynamic";

/** Super admin: connect Telnyx once, then give each clinic a number. */
export default async function PhoneSetupPage() {
  const session = await requireCallCenterPage();
  if (session.user.originalRole !== "SUPER_ADMIN") redirect("/call-center");
  const [setup, clinics] = await Promise.all([
    getSetup(),
    prisma.clinic.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        state: true,
        city: true,
        phone: true,
        phoneNumbers: { select: { id: true, e164: true, isDefault: true }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] },
      },
    }),
  ]);
  return (
    <PhoneSetupClient
      setup={setup}
      appUrl={process.env.NEXT_PUBLIC_APP_URL ?? null}
      clinics={clinics.map((c) => ({
        id: c.id,
        name: c.name,
        state: c.state,
        city: c.city,
        areaCode: (c.phone || "").replace(/\D/g, "").slice(-10, -7) || null,
        numbers: c.phoneNumbers,
      }))}
    />
  );
}
