import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { accessibleClinics, requireCallCenterPage } from "@/lib/call-center/access";
import { getSetup } from "@/lib/call-center/dialer";
import { loadPlan } from "@/lib/call-center/desk-server";
import { dayStats } from "@/lib/call-center/queue";
import { formatPhone } from "@/lib/phone";

export const dynamic = "force-dynamic";

/** Pick a clinic. The call center works one clinic at a time. */
export default async function CallCenterHome() {
  const session = await requireCallCenterPage();
  const isSuper = session.user.originalRole === "SUPER_ADMIN";
  const now = new Date();
  const [clinics, setup] = await Promise.all([accessibleClinics(session), getSetup()]);

  const cards = await Promise.all(
    clinics.map(async (c) => {
      const [{ plan, activities, newLeft }, numbers, total, live] = await Promise.all([
        loadPlan(c.id, session.user.id, now),
        prisma.clinicPhoneNumber.findMany({ where: { clinicId: c.id }, orderBy: [{ isDefault: "desc" }], select: { e164: true } }),
        prisma.lead.count({ where: { clinicId: c.id } }),
        prisma.dialerSession.count({
          where: { clinicId: c.id, status: { not: "ended" }, updatedAt: { gte: new Date(now.getTime() - 120_000) } },
        }),
      ]);
      return { clinic: c, plan, stats: dayStats(activities), newLeft, number: numbers[0]?.e164 ?? null, total, live };
    }),
  );

  return (
    <div className="space-y-6">
      {!setup.configured && (
        <div className="card-pad border-amber-200 bg-amber-50/60">
          <div className="text-sm font-semibold text-amber-900">Phone setup isn&apos;t finished</div>
          <p className="text-sm text-amber-900/80 mt-1">
            Until it is, the desk works like the old Dial Desk: dial from your own phone and log each result here.
            {isSuper ? " " : " A super admin can finish it."}
          </p>
          {isSuper && (
            <Link href="/call-center/phone-setup" className="btn-primary mt-3">
              Finish phone setup
            </Link>
          )}
        </div>
      )}

      {clinics.length === 0 ? (
        <div className="card-pad text-sm text-ink-muted">
          {isSuper
            ? "No active clinics yet."
            : "You haven't been given any clinics yet. Ask a RevOS admin to add you to the clinics you call for."}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {cards.map(({ clinic, plan, stats, newLeft, number, total, live }) => (
            <Link key={clinic.id} href={`/call-center/${clinic.id}`} className="card-pad hover:border-neutral-300 transition-colors block">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-base font-semibold text-ink">{clinic.name}</div>
                  <div className="text-xs text-ink-subtle mt-0.5">
                    {number ? `Calls from ${formatPhone(number)}` : "No Telnyx number yet"}
                  </div>
                </div>
                {live > 0 && <span className="badge-green">Live now</span>}
              </div>
              <div className="mt-5 grid grid-cols-3 gap-3">
                <Stat label="On today's list" value={plan.off ? "Off" : `${plan.done}/${plan.total}`} />
                <Stat label="Dials today" value={stats.dials} />
                <Stat label="Booked today" value={stats.booked} tone="good" />
              </div>
              <div className="mt-4 text-xs text-ink-subtle">
                {total === 0
                  ? "No leads yet. Import them to start."
                  : `${total.toLocaleString()} leads · ${newLeft.toLocaleString()} not called yet`}
                {plan.off && plan.offReason ? ` · ${plan.offReason}` : ""}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone?: "good" }) {
  return (
    <div>
      <div className={`text-xl font-semibold tabular-nums ${tone === "good" ? "text-emerald-700" : "text-ink"}`}>{value}</div>
      <div className="text-[11px] uppercase tracking-wider text-ink-subtle mt-0.5">{label}</div>
    </div>
  );
}
