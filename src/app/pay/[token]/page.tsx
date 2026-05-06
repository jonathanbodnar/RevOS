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
    (session.mode !== "payment" && session.mode !== "subscription")
  ) {
    notFound();
  }

  const meta = session.metadataJson ? safeJson(session.metadataJson) : {};
  const frequency = (meta as Record<string, string | null>).frequency ?? null;
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
          {session.status === "completed" ? (
            <div className="text-center py-6">
              <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 mb-3">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h2 className="text-lg font-semibold text-slate-900 mb-1">
                Payment received
              </h2>
              <p className="text-sm text-slate-500">
                Thanks! You can close this window.
              </p>
            </div>
          ) : session.status === "expired" ? (
            <div className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-md p-3 text-center">
              This payment link has expired. Please contact the clinic for a
              new one.
            </div>
          ) : (
            <>
              <div className="mb-5">
                <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">
                  {session.mode === "subscription" ? "Subscription" : "Amount due"}
                </p>
                <p className="text-3xl font-semibold text-slate-900 tabular-nums">
                  {formatMoney(session.amountCents)}
                  {session.mode === "subscription" && subTitle && (
                    <span className="text-base font-normal text-slate-500">
                      {" "}
                      / {subTitle}
                    </span>
                  )}
                </p>
                {session.description && (
                  <p className="text-sm text-slate-600 mt-1.5">
                    {session.description}
                  </p>
                )}
                {session.mode === "subscription" && (
                  <p className="text-xs text-slate-500 mt-3">
                    The first charge runs today. Future charges run automatically
                    {subTitle ? ` ${subTitle}` : ""}.
                  </p>
                )}
              </div>

              <PayClient token={token} mode={session.mode} />
            </>
          )}

          <p className="text-[11px] text-slate-400 mt-4 text-center">
            Card data is sent directly to Fortis (PCI-compliant).
          </p>
        </div>
      </div>
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
