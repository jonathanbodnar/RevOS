import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { EditClinicClient } from "./edit-clinic-client";

export default async function EditClinicPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const clinic = await prisma.clinic.findUnique({
    where: { id },
    select: { id: true, name: true, slug: true, logoUrl: true },
  });

  if (!clinic) notFound();

  return <EditClinicClient clinic={clinic} />;
}
