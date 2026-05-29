"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { formatMoneyCents } from "@/lib/format";

export function RefundButton({
  chargeId,
  maxCents,
  originalCents,
}: {
  chargeId: string;
  /** Remaining refundable balance in cents. */
  maxCents: number;
  /** Original charge amount in cents (for display). Defaults to maxCents. */
  originalCents?: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"full" | "partial">("full");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const original = originalCents ?? maxCents;
  const alreadyRefunded = Math.max(0, original - maxCents);

  function reset() {
    setMode("full");
    setAmount("");
    setError(null);
    setBusy(false);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    let body: { amount?: string } = {};
    if (mode === "partial") {
      const dollars = Number(amount.replace(/[$,]/g, "").trim());
      if (!Number.isFinite(dollars) || dollars <= 0) {
        setError("Enter a valid refund amount.");
        return;
      }
      if (Math.round(dollars * 100) > maxCents) {
        setError(`Amount can't exceed ${formatMoneyCents(maxCents)}.`);
        return;
      }
      body = { amount };
    }

    setBusy(true);
    const res = await fetch(`/api/clinic/charges/${chargeId}/refund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);

    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Refund failed.");
      return;
    }
    setOpen(false);
    reset();
    startTransition(() => router.refresh());
  }

  return (
    <>
      <button
        onClick={() => {
          reset();
          setOpen(true);
        }}
        disabled={busy || pending}
        className="btn-ghost text-red-600 hover:bg-red-50"
      >
        Refund
      </button>

      {open && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) setOpen(false);
          }}
        >
          <div className="card-pad max-w-sm w-full">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-slate-900">
                Issue refund
              </h2>
              <button
                className="btn-ghost p-1 text-slate-400 hover:text-slate-600"
                onClick={() => !busy && setOpen(false)}
                aria-label="Close"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <dl className="text-sm space-y-1 mb-4 rounded-lg bg-slate-50 border border-slate-100 px-3 py-2.5">
              <div className="flex justify-between">
                <dt className="text-slate-500">Original charge</dt>
                <dd className="tabular-nums text-slate-700">{formatMoneyCents(original)}</dd>
              </div>
              {alreadyRefunded > 0 && (
                <div className="flex justify-between">
                  <dt className="text-slate-500">Already refunded</dt>
                  <dd className="tabular-nums text-slate-700">−{formatMoneyCents(alreadyRefunded)}</dd>
                </div>
              )}
              <div className="flex justify-between font-medium">
                <dt className="text-slate-600">Refundable</dt>
                <dd className="tabular-nums text-slate-900">{formatMoneyCents(maxCents)}</dd>
              </div>
            </dl>

            <form onSubmit={submit} className="space-y-4">
              <div className="grid grid-cols-2 rounded-lg border border-slate-200 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setMode("full")}
                  className={`py-2 text-xs font-medium transition-colors ${
                    mode === "full"
                      ? "bg-brand-600 text-white"
                      : "text-slate-600 bg-white hover:bg-slate-50"
                  }`}
                >
                  Full refund
                </button>
                <button
                  type="button"
                  onClick={() => setMode("partial")}
                  className={`py-2 text-xs font-medium border-l border-slate-200 transition-colors ${
                    mode === "partial"
                      ? "bg-brand-600 text-white"
                      : "text-slate-600 bg-white hover:bg-slate-50"
                  }`}
                >
                  Partial refund
                </button>
              </div>

              {mode === "partial" && (
                <div>
                  <label className="label">Amount to refund (USD)</label>
                  <input
                    className="input"
                    autoFocus
                    inputMode="decimal"
                    placeholder={(maxCents / 100).toFixed(2)}
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    Up to {formatMoneyCents(maxCents)} can be refunded.
                  </p>
                </div>
              )}

              {error && (
                <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
                  {error}
                </div>
              )}

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn-secondary flex-1"
                  onClick={() => !busy && setOpen(false)}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary flex-1 bg-red-600 hover:bg-red-700"
                  disabled={busy}
                >
                  {busy
                    ? "Refunding…"
                    : mode === "full"
                      ? `Refund ${formatMoneyCents(maxCents)}`
                      : "Refund"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
