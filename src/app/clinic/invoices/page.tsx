import { requireClinicContext } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { PaymentLinksClient } from "./payment-links-client";

export default async function InvoicesPage() {
  const { clinicId } = await requireClinicContext();

  const [clinicSessions, globalSessions] = await Promise.all([
    // Clinic-specific payment links
    prisma.checkoutSession.findMany({
      where: {
        clinicId,
        mode: { in: ["payment", "subscription", "combined"] },
        customerId: null,
        isGlobal: false,
      },
      orderBy: { createdAt: "desc" },
      take: 500,
      include: {
        _count: { select: { charges: true, subscriptions: true } },
      },
    }),
    // Global payment links created by super admin
    prisma.checkoutSession.findMany({
      where: {
        isGlobal: true,
        mode: { in: ["payment", "subscription", "combined"] },
        customerId: null,
        status: "open",
      },
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        _count: { select: { charges: true, subscriptions: true } },
      },
    }),
  ]);

  const toRow = (s: (typeof clinicSessions)[0], isGlobal = false) => ({
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
    isGlobal,
  });

  const links = [
    ...clinicSessions.map((s) => toRow(s, false)),
    ...globalSessions.map((s) => toRow(s, true)),
  ];

  return <PaymentLinksClient links={links} />;
}
