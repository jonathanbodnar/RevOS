import { prisma } from "@/lib/prisma";
import { ImplementorsClient } from "./implementors-client";

export const dynamic = "force-dynamic";

export default async function ImplementorsPage() {
  const implementors = await prisma.implementor.findMany({
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
    include: { _count: { select: { customers: true } } },
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Implementors</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Sales implementors earn a commission per down payment. Customers are
          attributed automatically via the{" "}
          <code className="text-xs">?implementor=Name</code> tag on a payment
          link, or assigned manually on a customer profile.
        </p>
      </div>

      <ImplementorsClient
        implementors={implementors.map((i) => ({
          id: i.id,
          name: i.name,
          commissionCents: i.commissionCents,
          isActive: i.isActive,
          customerCount: i._count.customers,
        }))}
      />
    </div>
  );
}
