import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { PayClient } from "./client";

export const dynamic = "force-dynamic";

type Clinic = { id: string; name: string; logoUrl: string | null };

function formatMoney(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function frequencyLabel(freq: string | null): string | null {
  if (!freq) return null;
  switch (freq) {
    case "weekly":
      return "every week";
    case "monthly":
      return "every month";
    case "quarterly":
      return "every 3 months";
    case "yearly":
      return "every year";
    default:
      return freq;
  }
}

type Meta = {
  frequency?: string;
  setupFeeCents?: number;
  subscriptionAmountCents?: number;
  startAfterDays?: number;
  startsToday?: boolean;
  trial?: boolean;
  // legacy (pre-relative-start) field, still readable on old links
  startOn?: string;
  // installments
  installments?: boolean;
  scheduleType?: "frequency" | "dates";
  totalCents?: number;
  count?: number;
  perPaymentCents?: number[];
  remainingCount?: number;
  installFirstToday?: boolean;
  scheduledDates?: string[];
  firstIsToday?: boolean;
  // optional subscription after last installment
  subAmountCents?: number;
  subFrequency?: string;
};

function resolveStartAfterDays(meta: Meta): number {
  if (typeof meta.startAfterDays === "number") return Math.max(0, meta.startAfterDays);
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

export default async function PayPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ c?: string }>;
}) {
  const { token } = await params;
  const { c: clinicParam } = await searchParams;

  const session = await prisma.checkoutSession.findUnique({
    where: { token },
    include: { clinic: true },
  });

  if (
    !session ||
    !["payment", "subscription", "combined", "installments"].includes(session.mode)
  ) {
    notFound();
  }

  // For global links (clinicId = null), resolve the clinic from the ?c= param
  // so the payment page is branded for the clinic that shared the link.
  let displayClinic: Clinic | null = session.clinic;
  if (!displayClinic && clinicParam) {
    displayClinic = await prisma.clinic.findUnique({
      where: { id: clinicParam },
      select: { id: true, name: true, logoUrl: true },
    });
  }

  const meta = (session.metadataJson ? safeJson(session.metadataJson) : {}) as Meta;
  const frequency = meta.frequency ?? null;
  const subTitle = frequencyLabel(frequency);

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-white font-bold text-lg mb-3 overflow-hidden">
            {displayClinic?.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={displayClinic.logoUrl}
                alt={displayClinic.name}
                className="h-full w-full object-contain"
              />
            ) : (
              (displayClinic?.name ?? "R").charAt(0).toUpperCase()
            )}
          </div>
          <h1 className="text-xl font-semibold text-slate-900">
            {displayClinic?.name ?? "RevOS"}
          </h1>
        </div>

        <div className="card-pad">
          {session.status === "expired" ? (
            <div className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-md p-3 text-center">
              This payment link has expired. Please contact the clinic for a
              new one.
            </div>
          ) : (
            <>
              {/* Charge breakdown */}
              <div className="mb-5">
                {session.mode === "payment" && (
                  <>
                    <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">
                      Amount due
                    </p>
                    <p className="text-3xl font-semibold text-slate-900 tabular-nums">
                      {formatMoney(session.amountCents)}
                    </p>
                  </>
                )}

                {session.mode === "subscription" && (
                  <>
                    {meta.trial ? (
                      <>
                        <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">
                          Trial subscription
                        </p>
                        <p className="text-3xl font-semibold text-slate-900 tabular-nums">
                          {formatMoney(meta.subscriptionAmountCents ?? session.amountCents)}
                          {subTitle && (
                            <span className="text-base font-normal text-slate-500">
                              {" "}
                              / {subTitle}
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-slate-500 mt-3">
                          No charge today — your card will be saved securely.
                          The first payment runs on the next billing cycle.
                        </p>
                      </>
                    ) : (
                      <>
                        <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">
                          Subscription
                        </p>
                        <p className="text-3xl font-semibold text-slate-900 tabular-nums">
                          {formatMoney(session.amountCents)}
                          {subTitle && (
                            <span className="text-base font-normal text-slate-500">
                              {" "}
                              / {subTitle}
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-slate-500 mt-3">
                          The first charge runs today. Future charges run
                          automatically {subTitle}.
                        </p>
                      </>
                    )}
                  </>
                )}

                {session.mode === "combined" && (
                  <CombinedSummary session={session} meta={meta} />
                )}

                {session.mode === "installments" && meta.installments && (
                  <InstallmentsSummary meta={meta} />
                )}

                {session.description && !["combined", "installments"].includes(session.mode) && (
                  <p className="text-sm text-slate-600 mt-1.5">
                    {session.description}
                  </p>
                )}
              </div>

              <PayClient
                token={token}
                mode={session.mode as "payment" | "subscription" | "combined" | "installments"}
                clinicId={displayClinic?.id}
              />
            </>
          )}

          {/* Trust badge */}
          <div className="flex items-center justify-center gap-1.5 mt-4 text-[11px] text-slate-400">
            <svg
              className="w-3 h-3"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
              />
            </svg>
            <span>Secured by LunarPay • SSL Encryption</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function CombinedSummary({
  session,
  meta,
}: {
  session: { amountCents: number; description: string | null };
  meta: Meta;
}) {
  const setup = meta.setupFeeCents ?? 0;
  const subAmount = meta.subscriptionAmountCents ?? 0;
  const startAfterDays = resolveStartAfterDays(meta);
  const startsToday = startAfterDays === 0;
  const subTitle = frequencyLabel(meta.frequency ?? null);

  return (
    <div>
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">
        Today&apos;s charge
      </p>
      <p className="text-3xl font-semibold text-slate-900 tabular-nums mb-3">
        {formatMoney(session.amountCents)}
      </p>

      {session.description && (
        <p className="text-sm text-slate-600 mb-3">{session.description}</p>
      )}

      <ul className="text-sm text-slate-600 space-y-1.5 border-t border-slate-100 pt-3">
        {setup > 0 && (
          <li className="flex justify-between">
            <span>Setup fee</span>
            <span className="tabular-nums">{formatMoney(setup)}</span>
          </li>
        )}
        {startsToday && subAmount > 0 && (
          <li className="flex justify-between">
            <span>First subscription charge</span>
            <span className="tabular-nums">{formatMoney(subAmount)}</span>
          </li>
        )}
        <li className="flex justify-between text-slate-500 text-xs pt-2 mt-1 border-t border-slate-100">
          <span>Then {subTitle ?? "recurring"}</span>
          <span className="tabular-nums">
            {formatMoney(subAmount)}
            {subTitle ? ` / ${subTitle.replace("every ", "")}` : ""}
          </span>
        </li>
        {!startsToday && (
          <li className="flex justify-between text-slate-500 text-xs">
            <span>First subscription charge</span>
            <span>
              in {startAfterDays} day{startAfterDays === 1 ? "" : "s"}
            </span>
          </li>
        )}
      </ul>
    </div>
  );
}

function InstallmentsSummary({ meta }: { meta: Meta }) {
  const total = meta.totalCents ?? 0;
  const count = meta.count ?? 0;
  const perArr = Array.isArray(meta.perPaymentCents)
    ? meta.perPaymentCents
    : Array(count).fill(meta.perPaymentCents ?? 0);
  const scheduleType = meta.scheduleType ?? "frequency";

  // Determine today's charge
  const firstCents = perArr[0] ?? 0;
  const chargedToday =
    scheduleType === "dates"
      ? meta.firstIsToday
      : meta.installFirstToday ?? true;

  const freqLabel = frequencyLabel(meta.frequency ?? null);

  // Build payment rows
  const paymentRows: { label: string; cents: number }[] = [];
  if (scheduleType === "dates" && meta.scheduledDates) {
    meta.scheduledDates.forEach((date, i) => {
      paymentRows.push({
        label: new Date(`${date}T00:00:00`).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        }),
        cents: perArr[i] ?? firstCents,
      });
    });
  } else {
    paymentRows.push({ label: chargedToday ? "Today" : "Payment 1 (tonight)", cents: firstCents });
    const remaining = meta.remainingCount ?? count - (chargedToday ? 1 : 0);
    if (remaining > 0) {
      paymentRows.push({
        label: `+ ${remaining} more ${freqLabel ?? ""} payment${remaining !== 1 ? "s" : ""}`,
        cents: perArr[1] ?? firstCents,
      });
    }
  }

  return (
    <div>
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">
        Installment plan
      </p>
      <p className="text-3xl font-semibold text-slate-900 tabular-nums mb-1">
        {formatMoney(total)}
      </p>
      <p className="text-sm text-slate-500 mb-3">
        {count} payment{count !== 1 ? "s" : ""}
        {scheduleType === "frequency" && freqLabel ? ` · ${freqLabel}` : ""}
      </p>

      <ul className="text-sm text-slate-600 space-y-1.5 border-t border-slate-100 pt-3">
        {paymentRows.map((row, i) => (
          <li key={i} className={`flex justify-between ${i === 0 && chargedToday ? "font-medium" : "text-slate-500 text-xs"}`}>
            <span>{row.label}</span>
            <span className="tabular-nums">{formatMoney(row.cents)}</span>
          </li>
        ))}
        {meta.subAmountCents && meta.subAmountCents >= 50 && (
          <li className="flex justify-between text-slate-500 text-xs border-t border-slate-100 pt-2 mt-1">
            <span>+ Subscription starting today {frequencyLabel(meta.subFrequency ?? null) ?? ""}</span>
            <span className="tabular-nums">{formatMoney(meta.subAmountCents)}</span>
          </li>
        )}
      </ul>

      {!chargedToday && (
        <p className="text-xs text-slate-500 mt-3">
          No charge today — your card is saved and the first payment processes on the scheduled date.
        </p>
      )}
    </div>
  );
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
