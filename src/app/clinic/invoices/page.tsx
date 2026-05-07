import { requireClinicContext } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { PaymentLinksClient } from "./payment-links-client";

export default async function InvoicesPage() {
  const { clinicId } = await requireClinicContext();

  const sessions = await prisma.checkoutSession.findMany({
    where: {
      clinicId,
      // Reusable payment-link templates only — they have no upfront customer
      // and one of the payment-link modes. Legacy single-customer invoices
      // and save-card sessions are excluded.
      mode: { in: ["payment", "subscription", "combined"] },
      customerId: null,
    },
    orderBy: { createdAt: "desc" },
    take: 500,
    include: {
      _count: { select: { charges: true, subscriptions: true } },
    },
  });

  // Lightweight DTO so we can pass plain data to the client component.
  const links = sessions.map((s) => ({
    id: s.id,
    token: s.token,
    url: s.url,
    amountCents: s.amountCents,
    description: s.description,
    mode: s.mode,
    status: s.status,
    metadataJson: s.metadataJson,
    createdAt: s.createdAt,
    completedAt: s.completedAt,
    chargeCount: s._count.charges,
    subscriptionCount: s._count.subscriptions,
  }));

  return <PaymentLinksClient links={links} />;
}
