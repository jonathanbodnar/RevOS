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
            {session.clinic.name}
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Save your payment info{" "}
            {session.customer.firstName
              ? `for ${session.customer.firstName}`
              : ""}
          </p>
        </div>
        <div className="card-pad">
          {session.status === "completed" ? (
            <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-md p-3">
              Your payment method is saved. You can close this window.
            </div>
          ) : (
            <SaveCardClient token={token} />
          )}
          <p className="text-[11px] text-slate-400 mt-4 text-center">
            Card data is sent directly to Fortis (PCI-compliant).
          </p>
        </div>
      </div>
    </div>
  );
}
