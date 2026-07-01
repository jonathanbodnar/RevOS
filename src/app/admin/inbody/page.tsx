import { prisma } from "@/lib/prisma";
import { inbodyCanFetch, inbodyConfigured } from "@/lib/inbody";
import { InBodyClient } from "./inbody-client";

export const dynamic = "force-dynamic";

export default async function InBodyAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter } = await searchParams;
  const onlyUnmatched = filter === "unmatched";

  const tests = await prisma.inBodyTest.findMany({
    where: onlyUnmatched ? { customerId: null } : {},
    orderBy: [{ testedAt: "desc" }, { createdAt: "desc" }],
    take: 200,
    include: {
      customer: { select: { id: true, firstName: true, lastName: true, email: true } },
      clinic: { select: { name: true } },
    },
  });

  const [total, unmatched] = await Promise.all([
    prisma.inBodyTest.count(),
    prisma.inBodyTest.count({ where: { customerId: null } }),
  ]);

  const configured = inbodyConfigured();
  const canFetch = inbodyCanFetch();

  const webhookBase =
    process.env.NEXT_PUBLIC_APP_URL || "https://revosportal.com";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">InBody</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Body-composition tests delivered from LookinBody Web. Tests auto-pair
          to customers by phone number; unmatched tests can be mapped manually.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="card-pad">
          <div className="text-xs uppercase tracking-wide text-slate-400">Total tests</div>
          <div className="text-2xl font-semibold text-slate-900">{total}</div>
        </div>
        <div className="card-pad">
          <div className="text-xs uppercase tracking-wide text-slate-400">Unmatched</div>
          <div className="text-2xl font-semibold text-amber-600">{unmatched}</div>
        </div>
        <div className="card-pad">
          <div className="text-xs uppercase tracking-wide text-slate-400">API status</div>
          <div className="text-sm font-medium mt-1">
            <span className={configured ? "badge-green" : "badge-red"}>
              {configured ? "Key configured" : "No API key"}
            </span>{" "}
            <span className={canFetch ? "badge-green" : "badge-yellow"}>
              {canFetch ? "Fetch enabled" : "Fetch pending docs"}
            </span>
          </div>
        </div>
      </div>

      <InBodyClient
        webhookUrl={`${webhookBase.replace(/\/$/, "")}/api/webhooks/inbody`}
        canFetch={canFetch}
        onlyUnmatched={onlyUnmatched}
        tests={tests.map((t) => ({
          id: t.id,
          testedAt: t.testedAt ? t.testedAt.toISOString() : null,
          equip: t.equip,
          phone: t.phone,
          account: t.account,
          matchStatus: t.matchStatus,
          resultStatus: t.resultStatus,
          fetchError: t.fetchError,
          customer: t.customer
            ? {
                id: t.customer.id,
                name:
                  [t.customer.firstName, t.customer.lastName]
                    .filter(Boolean)
                    .join(" ")
                    .trim() ||
                  t.customer.email ||
                  t.customer.id,
              }
            : null,
          clinicName: t.clinic?.name ?? null,
          weightKg: t.weightKg,
          totalBodyWaterKg: t.totalBodyWaterKg,
          dryLeanMassKg: t.dryLeanMassKg,
          skeletalMuscleMassKg: t.skeletalMuscleMassKg,
          bodyFatMassKg: t.bodyFatMassKg,
          bmi: t.bmi,
          percentBodyFat: t.percentBodyFat,
          segLeanRightArmKg: t.segLeanRightArmKg,
          segLeanLeftArmKg: t.segLeanLeftArmKg,
          segLeanTrunkKg: t.segLeanTrunkKg,
          segLeanRightLegKg: t.segLeanRightLegKg,
          segLeanLeftLegKg: t.segLeanLeftLegKg,
          segLeanRightArmPct: t.segLeanRightArmPct,
          segLeanLeftArmPct: t.segLeanLeftArmPct,
          segLeanTrunkPct: t.segLeanTrunkPct,
          segLeanRightLegPct: t.segLeanRightLegPct,
          segLeanLeftLegPct: t.segLeanLeftLegPct,
        }))}
      />
    </div>
  );
}
