import { prisma } from "@/lib/prisma";
import { requireSuperAdmin } from "@/lib/session";
import { inbodyCanFetch, inbodyConfigured } from "@/lib/inbody";
import { InBodyClient } from "./inbody-client";
import { DevicesCard } from "./devices-card";

export const dynamic = "force-dynamic";

/**
 * Queue semantics. The default view is the triage queue — tests still waiting
 * for a human to pick a customer. Tests that are mapped and syncing are done
 * work and stay out of it; dismissed tests are retired but recoverable.
 */
const TAB_WHERE = {
  queue: { dismissedAt: null, customerId: null },
  needs_data: { dismissedAt: null, customerId: { not: null }, resultStatus: { not: "fetched" } },
  mapped: { dismissedAt: null, customerId: { not: null }, resultStatus: "fetched" },
  dismissed: { dismissedAt: { not: null } },
  all: {},
} as const;

type TabId = keyof typeof TAB_WHERE;

function resolveTab(filter: string | undefined): TabId {
  // "unmatched" is the pre-tabs bookmark for the same set.
  if (filter === "unmatched") return "queue";
  return filter && filter in TAB_WHERE ? (filter as TabId) : "queue";
}

export default async function InBodyAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  await requireSuperAdmin();
  const { filter } = await searchParams;
  const tab = resolveTab(filter);

  const tests = await prisma.inBodyTest.findMany({
    where: TAB_WHERE[tab],
    orderBy: [{ testedAt: "desc" }, { createdAt: "desc" }],
    take: 200,
    include: {
      customer: { select: { id: true, firstName: true, lastName: true, email: true } },
      clinic: { select: { name: true } },
    },
  });

  const [devices, clinics] = await Promise.all([
    prisma.inBodyDevice.findMany({
      orderBy: [{ clinicId: "asc" }, { serial: "asc" }],
      include: { clinic: { select: { name: true } } },
    }),
    prisma.clinic.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  const deviceStats = await prisma.inBodyTest.groupBy({
    by: ["equipSerial"],
    _count: { _all: true },
  });
  const unattributedBySerial = await prisma.inBodyTest.groupBy({
    by: ["equipSerial"],
    where: { clinicId: null },
    _count: { _all: true },
  });

  const [total, unmatched, queueCount, needsDataCount, mappedCount, dismissedCount] =
    await Promise.all([
      prisma.inBodyTest.count(),
      prisma.inBodyTest.count({ where: { customerId: null } }),
      prisma.inBodyTest.count({ where: TAB_WHERE.queue }),
      prisma.inBodyTest.count({ where: TAB_WHERE.needs_data }),
      prisma.inBodyTest.count({ where: TAB_WHERE.mapped }),
      prisma.inBodyTest.count({ where: TAB_WHERE.dismissed }),
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
              {configured ? "Credentials configured" : "Credentials incomplete"}
            </span>{" "}
            <span className={canFetch ? "badge-green" : "badge-yellow"}>
              {canFetch ? "Fetch enabled" : "Fetch unavailable"}
            </span>
          </div>
        </div>
      </div>

      <DevicesCard
        clinics={clinics}
        devices={devices.map((d) => ({
          id: d.id,
          serial: d.serial,
          label: d.label,
          clinicId: d.clinicId,
          clinicName: d.clinic?.name ?? null,
          lastSeenAt: d.lastSeenAt ? d.lastSeenAt.toISOString() : null,
          scans: deviceStats.find((s) => s.equipSerial === d.serial)?._count._all ?? 0,
          unattributed:
            unattributedBySerial.find((s) => s.equipSerial === d.serial)?._count._all ?? 0,
        }))}
      />

      <InBodyClient
        webhookUrl={`${webhookBase.replace(/\/$/, "")}/api/webhooks/inbody`}
        canFetch={canFetch}
        webhookSecretConfigured={Boolean(process.env.INBODY_WEBHOOK_SECRET)}
        tab={tab}
        tabCounts={{
          queue: queueCount,
          needs_data: needsDataCount,
          mapped: mappedCount,
          dismissed: dismissedCount,
          all: total,
        }}
        tests={tests.map((t) => ({
          id: t.id,
          dismissedAt: t.dismissedAt ? t.dismissedAt.toISOString() : null,
          dismissedReason: t.dismissedReason,
          testedAt: t.testedAt ? t.testedAt.toISOString() : null,
          equip: t.equip,
          equipSerial: t.equipSerial,
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
