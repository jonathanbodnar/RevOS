import Link from "next/link";
import { requireSuperAdmin } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { formatMoneyCents, formatDate, formatCardLabel } from "@/lib/format";
import { toCsv, csvMoney } from "@/lib/csv";
import { DownloadCsvButton } from "@/components/download-csv-button";
import { OpenCustomerLink } from "../transactions/open-customer-link";
import { RestartButton } from "./restart-button";

export const dynamic = "force-dynamic";

/**
 * Cross-clinic recurring revenue.
 *
 * The view that matters is "lost" — LunarPay gives up on a declining card and
 * cancels the subscription itself, which silently ends recurring revenue and,
 * before this page existed, looked identical to a deliberate cancellation.
 */
const TABS = {
  active: { label: "Active", where: { status: "active" } },
  lost: { label: "Lost to failed cards", where: { status: "cancelled", cancelReason: "auto_failed" } },
  cancelled: { label: "Cancelled by staff", where: { status: "cancelled", cancelReason: "manual" } },
  all_cancelled: { label: "All cancelled", where: { status: "cancelled" } },
  all: { label: "All", where: {} },
} as const;

type TabId = keyof typeof TABS;

/** Normalize to a monthly figure so totals across frequencies are comparable. */
function monthlyCents(amountCents: number, frequency: string): number {
  switch (frequency) {
    case "weekly":
      return Math.round((amountCents * 52) / 12);
    case "quarterly":
      return Math.round(amountCents / 3);
    case "yearly":
      return Math.round(amountCents / 12);
    default:
      return amountCents;
  }
}

export default async function AdminSubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  await requireSuperAdmin();
  const { tab: rawTab } = await searchParams;
  const tab: TabId = rawTab && rawTab in TABS ? (rawTab as TabId) : "active";

  const [subs, counts] = await Promise.all([
    prisma.subscription.findMany({
      where: { clinicId: { not: null }, ...TABS[tab].where },
      orderBy: [{ cancelledAt: "desc" }, { nextPaymentOn: "asc" }],
      take: 500,
      include: {
        customer: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            paymentMethods: {
              where: { isActive: true },
              select: {
                id: true,
                sourceType: true,
                lastDigits: true,
                expMonth: true,
                expYear: true,
                isDefault: true,
              },
              orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
            },
            subscriptions: { where: { status: "active" }, select: { id: true } },
          },
        },
        clinic: { select: { id: true, name: true } },
        paymentMethod: { select: { sourceType: true, lastDigits: true } },
      },
    }),
    Promise.all(
      (Object.keys(TABS) as TabId[]).map(async (k) => ({
        k,
        n: await prisma.subscription.count({
          where: { clinicId: { not: null }, ...TABS[k].where },
        }),
      })),
    ),
  ]);

  const countBy = Object.fromEntries(counts.map((c) => [c.k, c.n])) as Record<TabId, number>;
  const totalMonthly = subs.reduce((sum, s) => sum + monthlyCents(s.amountCents, s.frequency), 0);

  // A card is unusable once its expiry has passed — surfacing that in the
  // dialog beats a decline at restart time.
  const nowYm = new Date().toISOString().slice(2, 7).replace("-", ""); // "YYMM"
  const isExpired = (m: string | null, y: string | null) => {
    if (!m || !y) return false;
    const ym = `${y.padStart(2, "0").slice(-2)}${m.padStart(2, "0")}`;
    return ym < nowYm;
  };
  // Default the first payment to one cycle out, so a restart never lands on a
  // date the operator did not intend.
  const defaultStart = (frequency: string) => {
    const d = new Date();
    if (frequency === "weekly") d.setUTCDate(d.getUTCDate() + 7);
    else if (frequency === "quarterly") d.setUTCMonth(d.getUTCMonth() + 3);
    else if (frequency === "yearly") d.setUTCFullYear(d.getUTCFullYear() + 1);
    else d.setUTCMonth(d.getUTCMonth() + 1);
    return d.toISOString().slice(0, 10);
  };

  const nameOf = (s: (typeof subs)[number]) =>
    [s.customer.firstName, s.customer.lastName].filter(Boolean).join(" ") ||
    s.customer.email ||
    "Customer";

  const csv = toCsv(
    ["Patient", "Email", "Clinic", "Amount", "Frequency", "Monthly value", "Status", "Ended", "Reason", "Declines", "Card", "Next payment"],
    subs.map((s) => [
      nameOf(s),
      s.customer.email,
      s.clinic?.name ?? "—",
      csvMoney(s.amountCents),
      s.frequency,
      csvMoney(monthlyCents(s.amountCents, s.frequency)),
      s.status,
      s.cancelledAt ? s.cancelledAt.toISOString() : "",
      s.cancelReason ?? "",
      s.consecutiveFailures ?? "",
      formatCardLabel(s.paymentMethod) ?? "",
      s.nextPaymentOn ? s.nextPaymentOn.toISOString() : "",
    ]),
  );

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Recurring revenue</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Every clinic. &quot;Lost to failed cards&quot; is recurring revenue that
          ended on its own — LunarPay stops retrying a declining card and cancels
          the subscription, with no action from anyone here.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {(Object.keys(TABS) as TabId[]).map((k) => (
            <Link
              key={k}
              href={`/admin/subscriptions?tab=${k}`}
              className={tab === k ? "btn-primary px-3 py-1" : "btn-ghost px-3 py-1"}
            >
              {TABS[k].label}
              <span className="ml-1.5 text-xs opacity-70">{countBy[k] ?? 0}</span>
            </Link>
          ))}
        </div>
        <DownloadCsvButton csv={csv} filename={`subscriptions-${tab}.csv`} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
        <div className="card-pad">
          <div className="text-xs uppercase tracking-wide text-slate-400">Showing</div>
          <div className="text-2xl font-semibold text-slate-900">{subs.length}</div>
        </div>
        <div className="card-pad">
          <div className="text-xs uppercase tracking-wide text-slate-400">
            Monthly value
          </div>
          <div
            className={`text-2xl font-semibold ${tab === "active" ? "text-slate-900" : "text-red-600"}`}
          >
            {formatMoneyCents(totalMonthly)}
          </div>
        </div>
        <div className="card-pad">
          <div className="text-xs uppercase tracking-wide text-slate-400">
            Lost to failed cards
          </div>
          <div className="text-2xl font-semibold text-red-600">
            {countBy.lost ?? 0}
          </div>
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>Patient</th>
              <th>Clinic</th>
              <th>Amount</th>
              <th>Card</th>
              <th>Status</th>
              <th>Next / ended</th>
              <th className="text-right pr-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {subs.length === 0 && (
              <tr>
                <td colSpan={7} className="text-center text-slate-500 py-10">
                  Nothing here.
                </td>
              </tr>
            )}
            {subs.map((s) => (
              <tr key={s.id}>
                <td>
                  <OpenCustomerLink
                    customerId={s.customer.id}
                    clinicId={s.clinic?.id ?? null}
                    name={nameOf(s)}
                  />
                </td>
                <td className="text-slate-600">
                  {s.clinic ? (
                    <Link
                      href={`/admin/clinics/${s.clinic.id}`}
                      className="text-brand-600 hover:underline"
                    >
                      {s.clinic.name}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  {formatMoneyCents(s.amountCents)}
                  <div className="text-xs text-slate-400">{s.frequency}</div>
                </td>
                <td className="text-slate-600 text-xs whitespace-nowrap">
                  {formatCardLabel(s.paymentMethod) ?? (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td>
                  <span
                    className={
                      s.status === "active"
                        ? "badge-green"
                        : s.cancelReason === "auto_failed"
                          ? "badge-red"
                          : "badge-slate"
                    }
                  >
                    {s.status === "active"
                      ? "active"
                      : s.cancelReason === "auto_failed"
                        ? "card failed"
                        : "cancelled"}
                  </span>
                  {s.consecutiveFailures ? (
                    <div className="text-xs text-slate-400 mt-0.5">
                      {s.consecutiveFailures} declines
                    </div>
                  ) : null}
                </td>
                <td className="text-slate-500 text-xs">
                  {s.status === "active"
                    ? s.nextPaymentOn
                      ? formatDate(s.nextPaymentOn)
                      : "—"
                    : s.cancelledAt
                      ? formatDate(s.cancelledAt)
                      : "—"}
                </td>
                <td className="text-right pr-3">
                  {s.status === "cancelled" &&
                    s.customer.subscriptions.length === 0 && (
                      <RestartButton
                        subscriptionId={s.id}
                        patient={nameOf(s)}
                        amountLabel={formatMoneyCents(s.amountCents)}
                        frequency={s.frequency}
                        defaultStartOn={defaultStart(s.frequency)}
                        cards={s.customer.paymentMethods.map((pm) => ({
                          id: pm.id,
                          label: `${pm.sourceType === "ach" ? "Bank" : "Card"} •••• ${pm.lastDigits ?? "????"}${
                            pm.expMonth && pm.expYear
                              ? ` exp ${pm.expMonth}/${pm.expYear}`
                              : ""
                          }`,
                          isDefault: pm.isDefault,
                          expired: isExpired(pm.expMonth, pm.expYear),
                        }))}
                      />
                    )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
