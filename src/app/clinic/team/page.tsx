import { requireClinicContext } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { TeamClient } from "./team-client";
import { formatDate } from "@/lib/format";

export default async function TeamPage() {
  const { clinicId, session } = await requireClinicContext();

  const members = await prisma.user.findMany({
    where: { clinicId, role: "CLINIC_ADMIN" },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      email: true,
      isActive: true,
      createdAt: true,
    },
  });

  return (
    <TeamClient
      members={members.map((m) => ({
        ...m,
        createdAt: formatDate(m.createdAt),
      }))}
      currentUserId={session.user.id}
    />
  );
}
