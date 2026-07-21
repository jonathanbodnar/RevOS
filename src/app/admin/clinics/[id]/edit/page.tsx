import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireSuperAdmin } from "@/lib/session";
import { EditClinicClient } from "./edit-clinic-client";

export default async function EditClinicPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSuperAdmin();
  const { id } = await params;
  const clinic = await prisma.clinic.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      slug: true,
      logoUrl: true,
      revosDownPaymentSharePct: true,
      implementorFeeCents: true,
      revosRecurringShareCents: true,
    },
  });

  if (!clinic) notFound();

  return <EditClinicClient clinic={clinic} />;
}
