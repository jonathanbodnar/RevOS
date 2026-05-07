import { requireClinicContext } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { SettingsClient } from "./settings-client";

export default async function SettingsPage() {
  const { clinicId } = await requireClinicContext();
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { id: true, name: true, logoUrl: true },
  });

  if (!clinic) return null;

  return <SettingsClient clinic={clinic} />;
}
