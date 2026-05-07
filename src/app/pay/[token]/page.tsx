import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { PayClient } from "./client";

export const dynamic = "force-dynamic";

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
  // legacy (pre-relative-start) field, still readable on old links
  startOn?: string;
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
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const session = await prisma.checkoutSession.findUnique({
    where: { token },
    include: { clinic: true },
  });

  if (
    !session ||
    !["payment", "subscription", "combined"].includes(session.mode)
  ) {
    notFound();
  }

  const meta = (session.metadataJson ? safeJson(session.metadataJson) : {}) as Meta;
  const frequency = meta.frequency ?? null;
  const subTitle = frequencyLabel(frequency);

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-white font-bold text-lg mb-3">
            {session.clinic.name.charAt(0).toUpperCase()}
          </div>
          <h1 className="text-xl font-semibold text-slate-900">
            {session.clinic.name}
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

                {session.mode === "combined" && (
                  <CombinedSummary session={session} meta={meta} />
                )}

                {session.description && session.mode !== "combined" && (
                  <p className="text-sm text-slate-600 mt-1.5">
                    {session.description}
                  </p>
                )}
              </div>

              <PayClient token={token} mode={session.mode as "payment" | "subscription" | "combined"} />
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

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
