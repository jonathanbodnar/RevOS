import Link from "next/link";
import { notFound } from "next/navigation";
import { requireClinicContext } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { formatMoneyCents, formatDate } from "@/lib/format";
import { CopyButton } from "@/components/copy-button";
import { DeletePaymentLinkButton } from "./delete-button";

const MODE_LABELS: Record<string, string> = {
  payment: "One-time payment",
  subscription: "Subscription",
  combined: "Setup + subscription",
  installments: "Installments",
};

const MODE_COLORS: Record<string, string> = {
  payment: "badge-indigo",
  subscription: "badge-green",
  combined: "badge-purple",
  installments: "badge-yellow",
};

type LinkMeta = {
  frequency?: string;
  setupFeeCents?: number;
  subscriptionAmountCents?: number;
  startAfterDays?: number;
  startsToday?: boolean;
  // legacy
  startOn?: string;
};

function safeJson(s: string | null): LinkMeta {
  if (!s) return {};
  try {
    return JSON.parse(s) as LinkMeta;
  } catch {
    return {};
  }
}

function resolveStartAfterDays(meta: LinkMeta): number {
  if (typeof meta.startAfterDays === "number")
    return Math.max(0, meta.startAfterDays);
  if (meta.startsToday) return 0;
  if (meta.startOn) {
    const target = new Date(`${meta.startOn}T00:00:00`);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.max(
      0,
      Math.round((target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000)),
    );
  }
  return 0;
}

export default async function PaymentLinkDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { clinicId } = await requireClinicContext();

  const link = await prisma.checkoutSession.findFirst({
    where: { id, clinicId },
    include: {
      charges: {
        orderBy: { createdAt: "desc" },
        take: 100,
        include: {
          customer: true,
          paymentMethod: true,
        },
      },
      subscriptions: {
        orderBy: { createdAt: "desc" },
        take: 100,
        include: {
          customer: true,
        },
      },
    },
  });

  if (!link) notFound();

  // Defensive: this page is for reusable payment-link templates. Save-card
  // sessions are handled elsewhere.
  if (!["payment", "subscription", "combined"].includes(link.mode)) {
    notFound();
  }

  const meta = safeJson(link.metadataJson);
  const totalCharged = link.charges.reduce(
    (acc, c) => acc + (c.status === "paid" ? c.amountCents : 0),
    0,
  );
  const customerCount = new Set([
    ...link.charges.map((c) => c.customerId),
    ...link.subscriptions.map((s) => s.customerId),
  ]).size;

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Breadcrumb */}
      <div>
        <Link
          href="/clinic/invoices"
          className="text-xs text-slate-500 hover:underline"
        >
          ← Payment Links
        </Link>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className={MODE_COLORS[link.mode] ?? "badge-slate"}>
              {MODE_LABELS[link.mode] ?? link.mode}
            </span>
            <span className="badge-green">active</span>
          </div>
          <h2 className="text-xl font-semibold text-slate-900">
            {formatMoneyCents(link.amountCents)}
            {link.mode === "combined" && (
              <span className="text-sm font-normal text-slate-500"> today</span>
            )}
          </h2>
          {link.description && (
            <p className="text-sm text-slate-500 mt-0.5">{link.description}</p>
          )}
        </div>
        <DeletePaymentLinkButton id={link.id} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main column */}
        <div className="lg:col-span-2 space-y-5">
          {/* Stats */}
          <div className="grid grid-cols-3 gap-3">
            <div className="card-pad">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
                Payments
              </p>
              <p className="text-2xl font-semibold text-slate-900 tabular-nums">
                {link.charges.length}
              </p>
            </div>
            <div className="card-pad">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
                Customers
              </p>
              <p className="text-2xl font-semibold text-slate-900 tabular-nums">
                {customerCount}
              </p>
            </div>
            <div className="card-pad">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide">
                Collected
              </p>
              <p className="text-2xl font-semibold text-slate-900 tabular-nums">
                {formatMoneyCents(totalCharged)}
              </p>
            </div>
          </div>

          {/* Combined-mode breakdown */}
          {link.mode === "combined" && (
            <div className="card-pad space-y-3">
              <h3 className="text-sm font-semibold text-slate-900">
                Charge breakdown (per customer)
              </h3>
              <dl className="space-y-2 text-sm">
                {(meta.setupFeeCents ?? 0) > 0 && (
                  <div className="flex justify-between">
                    <dt className="text-slate-500">Setup fee (today)</dt>
                    <dd className="font-medium tabular-nums">
                      {formatMoneyCents(meta.setupFeeCents ?? 0)}
                    </dd>
                  </div>
                )}
                <div className="flex justify-between">
                  <dt className="text-slate-500">
                    Subscription
                    {meta.frequency ? ` (${meta.frequency})` : ""}
                  </dt>
                  <dd className="font-medium tabular-nums">
                    {formatMoneyCents(meta.subscriptionAmountCents ?? 0)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">First subscription charge</dt>
                  <dd>
                    {(() => {
                      const days = resolveStartAfterDays(meta);
                      if (days === 0) return "Day of payment (bundled with setup)";
                      return `${days} day${days === 1 ? "" : "s"} after payment`;
                    })()}
                  </dd>
                </div>
                <div className="flex justify-between border-t border-slate-100 pt-2">
                  <dt className="text-slate-700 font-medium">Today total</dt>
                  <dd className="font-semibold tabular-nums">
                    {formatMoneyCents(link.amountCents)}
                  </dd>
                </div>
              </dl>
            </div>
          )}

          {/* Payments list */}
          <div className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100">
              <h3 className="text-sm font-semibold text-slate-900">
                Payments
              </h3>
            </div>
            {link.charges.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-500">
                No payments yet. Share the link to start collecting.
              </div>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Amount</th>
                    <th>Method</th>
                    <th>Status</th>
                    <th>Paid</th>
                  </tr>
                </thead>
                <tbody>
                  {link.charges.map((c) => {
                    const cust = c.customer;
                    const name =
                      [cust.firstName, cust.lastName]
                        .filter(Boolean)
                        .join(" ") ||
                      cust.email ||
                      "Customer";
                    return (
                      <tr key={c.id}>
                        <td>
                          <Link
                            href={`/clinic/customers/${cust.id}`}
                            className="text-brand-600 hover:underline text-sm font-medium"
                          >
                            {name}
                          </Link>
                          {cust.email && (
                            <div className="text-xs text-slate-500">
                              {cust.email}
                            </div>
                          )}
                        </td>
                        <td className="font-medium tabular-nums">
                          {formatMoneyCents(c.amountCents)}
                        </td>
                        <td className="text-sm text-slate-600">
                          {c.paymentMethod ? (
                            <>
                              {c.paymentMethod.sourceType === "ach"
                                ? "Bank"
                                : "Card"}{" "}
                              •••• {c.paymentMethod.lastDigits ?? "????"}
                            </>
                          ) : (
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
                        <td className="text-slate-500 text-xs whitespace-nowrap">
                          {formatDate(c.createdAt)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Subscriptions list */}
          {(link.mode === "subscription" || link.mode === "combined") && (
            <div className="card overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100">
                <h3 className="text-sm font-semibold text-slate-900">
                  Subscriptions
                </h3>
              </div>
              {link.subscriptions.length === 0 ? (
                <div className="p-8 text-center text-sm text-slate-500">
                  No subscriptions yet.
                </div>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>Customer</th>
                      <th>Amount</th>
                      <th>Frequency</th>
                      <th>Next charge</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {link.subscriptions.map((s) => {
                      const cust = s.customer;
                      const name =
                        [cust.firstName, cust.lastName]
                          .filter(Boolean)
                          .join(" ") ||
                        cust.email ||
                        "Customer";
                      return (
                        <tr key={s.id}>
                          <td>
                            <Link
                              href={`/clinic/customers/${cust.id}`}
                              className="text-brand-600 hover:underline text-sm font-medium"
                            >
                              {name}
                            </Link>
                          </td>
                          <td className="font-medium tabular-nums">
                            {formatMoneyCents(s.amountCents)}
                          </td>
                          <td className="text-sm text-slate-600 capitalize">
                            {s.frequency}
                          </td>
                          <td className="text-sm text-slate-600">
                            {s.nextPaymentOn ? formatDate(s.nextPaymentOn) : "—"}
                          </td>
                          <td>
                            <span
                              className={
                                s.status === "active"
                                  ? "badge-green"
                                  : "badge-slate"
                              }
                            >
                              {s.status}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-5">
          {/* Payment link URL */}
          <div className="card-pad">
            <h3 className="text-sm font-semibold text-slate-900 mb-3">
              Shareable link
            </h3>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={link.url}
                className="input flex-1 font-mono text-xs"
              />
              <CopyButton value={link.url} />
            </div>
            <p className="text-xs text-slate-500 mt-2">
              Reusable — every customer who pays through this link gets a new
              profile and a saved card.
            </p>
          </div>

          {/* Link details */}
          <div className="card-pad">
            <h3 className="text-sm font-semibold text-slate-900 mb-3">
              Details
            </h3>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-500">Amount</dt>
                <dd className="font-medium">
                  {formatMoneyCents(link.amountCents)}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Created</dt>
                <dd className="text-slate-700">{formatDate(link.createdAt)}</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}
