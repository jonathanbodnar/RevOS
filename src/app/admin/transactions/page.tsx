import Link from "next/link";
import { requireSuperAdmin } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { formatMoneyCents, formatDate } from "@/lib/format";
import { toCsv, csvMoney } from "@/lib/csv";
import { DownloadCsvButton } from "@/components/download-csv-button";
import { OpenCustomerLink } from "./open-customer-link";

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
  searchParams: Promise<{ status?: string; days?: string }>;
}) {
  await requireSuperAdmin();
  const { status, days } = await searchParams;
  const statusFilter = STATUS_FILTERS.includes(status as StatusFilter)
    ? (status as StatusFilter)
    : null;
  const windowDays = days === "all" ? null : Math.min(365, Math.max(1, Number(days) || 30));
  const since = windowDays
    ? new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
    : null;

  const charges = await prisma.charge.findMany({
    where: {
      clinicId: { not: null },
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(since ? { createdAt: { gte: since } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 500,
    include: {
      customer: { select: { id: true, firstName: true, lastName: true, email: true } },
      clinic: { select: { id: true, name: true } },
    },
  });

  const nameOf = (c: (typeof charges)[number]) =>
    [c.customer.firstName, c.customer.lastName].filter(Boolean).join(" ") ||
    c.customer.email ||
    "Customer";

  const csv = toCsv(
    ["Customer", "Email", "Clinic", "Amount", "Status", "Description", "When"],
    charges.map((c) => [
      nameOf(c),
      c.customer.email,
      c.clinic?.name ?? "—",
      csvMoney(c.amountCents),
      c.status,
      c.description,
      c.createdAt.toISOString(),
    ]),
  );

  const qs = (next: { status?: string | null; days?: string | null }) => {
    const p = new URLSearchParams();
    const s = next.status === undefined ? statusFilter : next.status;
    const d = next.days === undefined ? (windowDays ? String(windowDays) : "all") : next.days;
    if (s) p.set("status", s);
    if (d && d !== "30") p.set("days", d);
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
              <th>Status</th>
              <th>Description</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {charges.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-slate-500 py-10">
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
