import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { SaveCardClient } from "./client";

export const dynamic = "force-dynamic";

export default async function SaveCardPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const session = await prisma.checkoutSession.findUnique({
    where: { token },
    include: { customer: true, clinic: true },
  });
  if (!session || session.mode !== "save_card" || !session.customer) {
    notFound();
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-white font-bold text-lg mb-3">
            R
          </div>
          <h1 className="text-xl font-semibold text-slate-900">
            {session.clinic?.name ?? "RevOS"}
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Please update your payment information
          </p>
        </div>
        <div className="card-pad">
          {session.status === "completed" ? (
            <div className="text-center py-6">
              <div className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 mb-3">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <p className="text-sm font-medium text-slate-900">Card saved successfully</p>
              <p className="text-xs text-slate-500 mt-1">You can close this window.</p>
            </div>
          ) : (
            <SaveCardClient token={token} />
          )}
          <div className="flex items-center justify-center gap-1.5 mt-4 text-[11px] text-slate-400">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            <span>Secured by LunarPay • SSL Encryption</span>
          </div>
        </div>
      </div>
    </div>
  );
}
