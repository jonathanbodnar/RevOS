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
  save_card: "Save card",
};

const MODE_COLORS: Record<string, string> = {
  payment: "badge-indigo",
  subscription: "badge-green",
  combined: "badge-purple",
  installments: "badge-yellow",
  save_card: "badge-slate",
};

type LinkMeta = {
  frequency?: string;
  setupFeeCents?: number;
  subscriptionAmountCents?: number;
  startOn?: string;
  startsToday?: boolean;
};

function safeJson(s: string | null): LinkMeta {
  if (!s) return {};
  try {
    return JSON.parse(s) as LinkMeta;
  } catch {
    return {};
  }
}

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { clinicId } = await requireClinicContext();

  const session = await prisma.checkoutSession.findFirst({
    where: { id, clinicId },
    include: {
      customer: true,
    },
  });

  if (!session) notFound();

  // Look up the charge that came from this session (matched by description + customer + approximate time)
  // The webhook records the charge; we look for it here for display purposes.
  const relatedCharge = session.customerId
    ? await prisma.charge.findFirst({
        where: {
          clinicId,
          customerId: session.customerId,
          description: session.description,
          amountCents: session.amountCents,
          createdAt: { gte: session.createdAt },
        },
        orderBy: { createdAt: "asc" },
        include: { paymentMethod: true },
      })
    : null;

  // Look up related subscription (if mode=subscription)
  const relatedSubscription =
    session.mode === "subscription" && session.customerId
      ? await prisma.subscription.findFirst({
          where: {
            clinicId,
            customerId: session.customerId,
            amountCents: session.amountCents,
            createdAt: { gte: session.createdAt },
          },
          orderBy: { createdAt: "asc" },
        })
      : null;

  const expiresAt = new Date(session.createdAt.getTime() + 24 * 60 * 60 * 1000);
  const isExpiredByTime = new Date() > expiresAt;
  const effectiveStatus =
    session.status === "open" && isExpiredByTime ? "expired" : session.status;

  const meta = safeJson(session.metadataJson);

  const customer = session.customer;
  const fullName = customer
    ? [customer.firstName, customer.lastName].filter(Boolean).join(" ") ||
      customer.email ||
      "Customer"
    : null;

  return (
    <div className="space-y-6 max-w-3xl">
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
            <span
              className={MODE_COLORS[session.mode] ?? "badge-slate"}
            >
              {MODE_LABELS[session.mode] ?? session.mode}
            </span>
            <span
              className={
                effectiveStatus === "completed"
                  ? "badge-green"
                  : effectiveStatus === "expired"
                    ? "badge-slate"
                    : "badge-yellow"
              }
            >
              {effectiveStatus}
            </span>
          </div>
          <h2 className="text-xl font-semibold text-slate-900">
            {formatMoneyCents(session.amountCents)}
            {session.mode === "combined" && (
              <span className="text-sm font-normal text-slate-500"> today</span>
            )}
          </h2>
          {session.description && (
            <p className="text-sm text-slate-500 mt-0.5">{session.description}</p>
          )}
        </div>
        {session.status !== "completed" && (
          <DeletePaymentLinkButton id={session.id} />
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main info */}
        <div className="lg:col-span-2 space-y-5">
          {/* Session details */}
          <div className="card-pad space-y-3">
            <h3 className="text-sm font-semibold text-slate-900">
              Link details
            </h3>
            <dl className="space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-500">Status</dt>
                <dd>
                  <span
                    className={
                      effectiveStatus === "completed"
                        ? "badge-green"
                        : effectiveStatus === "expired"
                          ? "badge-slate"
                          : "badge-yellow"
                    }
                  >
                    {effectiveStatus}
                  </span>
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">Amount</dt>
                <dd className="font-medium">{formatMoneyCents(session.amountCents)}</dd>
              </div>
              {session.description && (
                <div className="flex justify-between">
                  <dt className="text-slate-500">Description</dt>
                  <dd>{session.description}</dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-slate-500">Created</dt>
                <dd className="text-slate-700">{formatDate(session.createdAt)}</dd>
              </div>
              {effectiveStatus === "open" && (
                <div className="flex justify-between">
                  <dt className="text-slate-500">Expires</dt>
                  <dd className="text-slate-700">{formatDate(expiresAt)}</dd>
                </div>
              )}
              {session.completedAt && (
                <div className="flex justify-between">
                  <dt className="text-slate-500">Paid at</dt>
                  <dd className="text-emerald-700 font-medium">
                    {formatDate(session.completedAt)}
                  </dd>
                </div>
              )}
            </dl>
          </div>

          {/* Combined-mode breakdown */}
          {session.mode === "combined" && (
            <div className="card-pad space-y-3">
              <h3 className="text-sm font-semibold text-slate-900">
                Charge breakdown
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
                    {meta.startsToday
                      ? "Today (bundled with setup)"
                      : meta.startOn
                      ? new Date(`${meta.startOn}T00:00:00`).toLocaleDateString(
                          "en-US",
                          { month: "long", day: "numeric", year: "numeric" },
                        )
                      : "—"}
                  </dd>
                </div>
                <div className="flex justify-between border-t border-slate-100 pt-2">
                  <dt className="text-slate-700 font-medium">Today total</dt>
                  <dd className="font-semibold tabular-nums">
                    {formatMoneyCents(session.amountCents)}
                  </dd>
                </div>
              </dl>
            </div>
          )}

          {/* Payment link URL */}
          {effectiveStatus === "open" && (
            <div className="card-pad">
              <h3 className="text-sm font-semibold text-slate-900 mb-3">
                Payment link
              </h3>
              <div className="flex items-center gap-2">
                <input
                  readOnly
                  value={session.url}
                  className="input flex-1 font-mono text-xs"
                />
                <CopyButton value={session.url} />
              </div>
              <p className="text-xs text-slate-500 mt-2">
                Share this link with the customer. It expires in 24 hours and
                accepts card or bank transfer.
              </p>
            </div>
          )}

          {/* Transaction details (if completed) */}
          {relatedCharge && (
            <div className="card-pad space-y-3">
              <h3 className="text-sm font-semibold text-slate-900">
                Transaction
              </h3>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-slate-500">Amount charged</dt>
                  <dd className="font-medium">
                    {formatMoneyCents(relatedCharge.amountCents)}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Method</dt>
                  <dd>
                    {relatedCharge.paymentMethod ? (
                      <>
                        {relatedCharge.paymentMethod.sourceType === "ach"
                          ? "Bank"
                          : "Card"}{" "}
                        ••••{" "}
                        {relatedCharge.paymentMethod.lastDigits ?? "????"}
                      </>
                    ) : (
                      <span className="text-slate-400">—</span>
                    )}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Status</dt>
                  <dd>
                    <span
                      className={
                        relatedCharge.status === "paid"
                          ? "badge-green"
                          : relatedCharge.status === "refunded"
                            ? "badge-slate"
                            : relatedCharge.status === "failed"
                              ? "badge-red"
                              : "badge-yellow"
                      }
                    >
                      {relatedCharge.status}
                    </span>
                  </dd>
                </div>
                {relatedCharge.fortisTransactionId && (
                  <div className="flex justify-between">
                    <dt className="text-slate-500">Fortis ID</dt>
                    <dd className="font-mono text-xs text-slate-600">
                      {relatedCharge.fortisTransactionId}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          )}

          {/* Subscription details */}
          {relatedSubscription && (
            <div className="card-pad space-y-3">
              <h3 className="text-sm font-semibold text-slate-900">
                Recurring subscription
              </h3>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-slate-500">Frequency</dt>
                  <dd className="capitalize">{relatedSubscription.frequency}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Status</dt>
                  <dd>
                    <span
                      className={
                        relatedSubscription.status === "active"
                          ? "badge-green"
                          : "badge-slate"
                      }
                    >
                      {relatedSubscription.status}
                    </span>
                  </dd>
                </div>
                {relatedSubscription.nextPaymentOn && (
                  <div className="flex justify-between">
                    <dt className="text-slate-500">Next charge</dt>
                    <dd>{formatDate(relatedSubscription.nextPaymentOn)}</dd>
                  </div>
                )}
              </dl>
              <Link
                href={`/clinic/customers/${session.customerId}`}
                className="text-xs text-brand-600 hover:underline"
              >
                Manage subscription on customer page →
              </Link>
            </div>
          )}
        </div>

        {/* Customer sidebar */}
        <div className="space-y-5">
          {customer ? (
            <div className="card-pad">
              <h3 className="text-sm font-semibold text-slate-900 mb-3">
                Customer
              </h3>
              <div className="space-y-1">
                <Link
                  href={`/clinic/customers/${customer.id}`}
                  className="text-brand-600 hover:underline font-medium text-sm"
                >
                  {fullName}
                </Link>
                {customer.email && (
                  <p className="text-sm text-slate-500">{customer.email}</p>
                )}
                {customer.phone && (
                  <p className="text-sm text-slate-500">{customer.phone}</p>
                )}
              </div>
              <div className="mt-4">
                <Link
                  href={`/clinic/customers/${customer.id}`}
                  className="btn-secondary text-xs w-full justify-center"
                >
                  View customer →
                </Link>
              </div>
            </div>
          ) : (
            <div className="card-pad">
              <h3 className="text-sm font-semibold text-slate-900 mb-2">
                Customer
              </h3>
              <p className="text-sm text-slate-500">No customer linked.</p>
            </div>
          )}

          {/* Token info */}
          <div className="card-pad">
            <h3 className="text-sm font-semibold text-slate-900 mb-2">
              Reference
            </h3>
            <dl className="space-y-1.5 text-xs">
              <div>
                <dt className="text-slate-500">Session token</dt>
                <dd className="font-mono text-slate-700 break-all">
                  {session.token}
                </dd>
              </div>
              <div>
                <dt className="text-slate-500">LunarPay session ID</dt>
                <dd className="font-mono text-slate-700">
                  {session.lunarpaySessionId}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}
