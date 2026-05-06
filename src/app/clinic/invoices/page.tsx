import { requireClinicContext } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { PaymentLinksClient } from "./payment-links-client";

export default async function InvoicesPage() {
  const { clinicId } = await requireClinicContext();

  const [sessions, customers] = await Promise.all([
    prisma.checkoutSession.findMany({
      where: { clinicId },
      orderBy: { createdAt: "desc" },
      take: 500,
      include: { customer: true },
    }),
    prisma.customer.findMany({
      where: { clinicId },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      select: { id: true, firstName: true, lastName: true, email: true },
    }),
  ]);

  return <PaymentLinksClient sessions={sessions} customers={customers} />;
}
