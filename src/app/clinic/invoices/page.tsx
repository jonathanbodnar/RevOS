import { requireClinicContext } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { PaymentLinksClient } from "./payment-links-client";

export default async function InvoicesPage() {
  const { clinicId } = await requireClinicContext();

  const sessions = await prisma.checkoutSession.findMany({
    where: { clinicId },
    orderBy: { createdAt: "desc" },
    take: 500,
    include: { customer: true },
  });

  return <PaymentLinksClient sessions={sessions} />;
}
