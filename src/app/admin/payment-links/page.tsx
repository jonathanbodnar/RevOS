import { requireSuperAdmin } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { AdminPaymentLinksClient } from "./payment-links-client";

export default async function AdminPaymentLinksPage() {
  await requireSuperAdmin();

  const sessions = await prisma.checkoutSession.findMany({
    where: {
      isGlobal: true,
      mode: { in: ["payment", "subscription", "combined"] },
      customerId: null,
    },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { charges: true, subscriptions: true } },
    },
  });

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

  return <AdminPaymentLinksClient links={links} />;
}
