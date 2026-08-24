import Link from "next/link";
import { requireSuperAdmin } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { formatMoneyCents, formatDate, formatCardLabel } from "@/lib/format";
import { toCsv, csvMoney } from "@/lib/csv";
import { DownloadCsvButton } from "@/components/download-csv-button";
import { OpenCustomerLink } from "./open-customer-link";
import { FollowUpSelect } from "./follow-up-select";
import { FOLLOW_UP_LABELS, isFollowUpStatus } from "@/lib/follow-up";

export const dynamic = "force-dynamic";

const STATUS_FILTERS = ["paid", "pending", "failed", "refunded"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

/**
 * Cross-clinic transactions — the drill-down behind the overview's
 * "Failed (30d)" stat.
 *
 * Super-admin only: this lists patient names/emails, which the billing
 * department must not see (their surfaces stay aggregate + customerId only).
 */
export default async function AdminTransactionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; days?: string; followUp?: string }>;
}) {
  await requireSuperAdmin();
  const { status, days, followUp } = await searchParams;
  const statusFilter = STATUS_FILTERS.includes(status as StatusFilter)
    ? (status as StatusFilter)
    : null;
  const followUpFilter = isFollowUpStatus(followUp) ? followUp : null;
  const windowDays = days === "all" ? null : Math.min(365, Math.max(1, Number(days) || 30));
  const since = windowDays
    ? new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
    : null;

  const charges = await prisma.charge.findMany({
    where: {
      clinicId: { not: null },
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(since ? { createdAt: { gte: since } } : {}),
      ...(followUpFilter ? { followUpStatus: followUpFilter } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 500,
    include: {
      customer: { select: { id: true, firstName: true, lastName: true, email: true } },
      clinic: { select: { id: true, name: true } },
      paymentMethod: { select: { sourceType: true, lastDigits: true } },
    },
  });

  // One real decline is often stored as two rows (payment-link mints a
  // synthetic id, the webhook writes the real transaction id), so offer to
  // apply an outcome across a patient's other untouched failures in one go.
  const openFailuresByCustomer = new Map<string, number>();
  for (const c of charges) {
    if (c.status !== "failed" || c.followUpStatus !== "new") continue;
    openFailuresByCustomer.set(
      c.customerId,
      (openFailuresByCustomer.get(c.customerId) ?? 0) + 1,
    );
  }

  const nameOf = (c: (typeof charges)[number]) =>
    [c.customer.firstName, c.customer.lastName].filter(Boolean).join(" ") ||
    c.customer.email ||
    "Customer";

  const csv = toCsv(
    ["Customer", "Email", "Clinic", "Amount", "Card", "Status", "Follow-up", "Note", "Description", "When"],
    charges.map((c) => [
      nameOf(c),
      c.customer.email,
      c.clinic?.name ?? "—",
      csvMoney(c.amountCents),
      formatCardLabel(c.paymentMethod) ?? "",
      c.status,
      c.status === "failed" ? c.followUpStatus : "",
      c.followUpNote,
      c.description,
      c.createdAt.toISOString(),
    ]),
  );

  const qs = (next: {
    status?: string | null;
    days?: string | null;
    followUp?: string | null;
  }) => {
    const p = new URLSearchParams();
    const s = next.status === undefined ? statusFilter : next.status;
    const d = next.days === undefined ? (windowDays ? String(windowDays) : "all") : next.days;
    const f = next.followUp === undefined ? followUpFilter : next.followUp;
    if (s) p.set("status", s);
    if (d && d !== "30") p.set("days", d);
    if (f) p.set("followUp", f);
    const q = p.toString();
    return q ? `/admin/transactions?${q}` : "/admin/transactions";
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Transactions</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Every clinic. Click a patient to open their profile in that clinic&apos;s
          context.
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          <Link
            href={qs({ status: null })}
            className={statusFilter ? "btn-ghost px-3 py-1" : "btn-primary px-3 py-1"}
          >
            All
          </Link>
          {STATUS_FILTERS.map((s) => (
            <Link
              key={s}
              href={qs({ status: s })}
              className={statusFilter === s ? "btn-primary px-3 py-1" : "btn-ghost px-3 py-1"}
            >
              {s[0].toUpperCase() + s.slice(1)}
            </Link>
          ))}
        </div>
        <div className="flex items-center gap-2 text-xs">
          {[
            { label: "30 days", value: "30" },
            { label: "90 days", value: "90" },
            { label: "All time", value: "all" },
          ].map((w) => {
            const active =
              w.value === "all" ? windowDays === null : String(windowDays) === w.value;
            return (
              <Link
                key={w.value}
                href={qs({ days: w.value })}
                className={active ? "btn-primary px-2 py-0.5" : "btn-ghost px-2 py-0.5"}
              >
                {w.label}
              </Link>
            );
          })}
          <DownloadCsvButton
            csv={csv}
            filename={`transactions-${statusFilter ?? "all"}.csv`}
          />
        </div>
      </div>

      {/* Follow-up is a property of failed payments, so only offer to filter
          by it where it means something. */}
      {statusFilter === "failed" && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-slate-500">Follow-up:</span>
          <Link
            href={qs({ followUp: null })}
            className={followUpFilter ? "btn-ghost px-2 py-0.5" : "btn-primary px-2 py-0.5"}
          >
            Any
          </Link>
          {Object.entries(FOLLOW_UP_LABELS).map(([value, label]) => (
            <Link
              key={value}
              href={qs({ followUp: value })}
              className={
                followUpFilter === value ? "btn-primary px-2 py-0.5" : "btn-ghost px-2 py-0.5"
              }
            >
              {label}
            </Link>
          ))}
        </div>
      )}

      <p className="text-sm text-slate-500">
        {charges.length} transaction{charges.length === 1 ? "" : "s"}
        {charges.length >= 500 ? " (latest 500)" : ""}
      </p>

      <div className="card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>Patient</th>
              <th>Clinic</th>
              <th>Amount</th>
              <th>Card</th>
              <th>Status</th>
              <th>Follow-up</th>
              <th>Description</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {charges.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center text-slate-500 py-10">
                  No {statusFilter ?? ""} transactions in this window.
                </td>
              </tr>
            )}
            {charges.map((c) => (
              <tr key={c.id}>
                <td>
                  <OpenCustomerLink
                    customerId={c.customer.id}
                    clinicId={c.clinic?.id ?? null}
                    name={nameOf(c)}
                  />
                </td>
                <td className="text-slate-600">
                  {c.clinic ? (
                    <Link
                      href={`/admin/clinics/${c.clinic.id}`}
                      className="text-brand-600 hover:underline"
                    >
                      {c.clinic.name}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td>{formatMoneyCents(c.amountCents)}</td>
                <td className="text-slate-600 text-xs whitespace-nowrap">
                  {formatCardLabel(c.paymentMethod) ?? (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td>
                  <span
                    className={
                      c.status === "paid"
                        ? "badge-green"
                        : c.status === "refunded"
                          ? "badge-slate"
                          : c.status === "failed"
                            ? "badge-red"
                            : "badge-yellow"
                    }
                  >
                    {c.status}
                  </span>
                </td>
                <td>
                  {c.status === "failed" ? (
                    <FollowUpSelect
                      chargeId={c.id}
                      value={c.followUpStatus}
                      note={c.followUpNote}
                      otherOpenCount={Math.max(
                        0,
                        (openFailuresByCustomer.get(c.customerId) ?? 0) -
                          (c.followUpStatus === "new" ? 1 : 0),
                      )}
                    />
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td className="text-slate-600">{c.description || "—"}</td>
                <td className="text-slate-500 text-xs">{formatDate(c.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
