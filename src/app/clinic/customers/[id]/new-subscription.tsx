"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CopyButton } from "@/components/copy-button";

const FEE_PERCENT = 0.039;
const FEE_FLAT_CENTS = 39;

function calcFee(baseCents: number) {
  const feeCents = Math.round(baseCents * FEE_PERCENT) + FEE_FLAT_CENTS;
  return { feeCents, totalCents: baseCents + feeCents };
}

function formatMoney(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function parseAmount(raw: string): number | null {
  const n = parseFloat(raw.replace(/[^0-9.]/g, ""));
  if (isNaN(n) || n <= 0) return null;
  return Math.round(n * 100);
}

export function NewSubscriptionForm({
  customerId,
  methods = [],
}: {
  customerId: string;
  methods?: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] = useState("monthly");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [link, setLink] = useState<string | null>(null);

  // Schedule the first cycle for a future date instead of charging now.
  const [scheduleFirst, setScheduleFirst] = useState(false);
  const [startOn, setStartOn] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 30);
    return d.toISOString().slice(0, 10);
  });

  const hasCards = methods.length > 0;
  // "" = generate a payment link; otherwise the chosen saved card.
  const [paymentMethodId, setPaymentMethodId] = useState(methods[0]?.id ?? "");

  useEffect(() => {
    if (!paymentMethodId && methods[0]?.id) setPaymentMethodId(methods[0].id);
  }, [methods, paymentMethodId]);

  const feePreview = useMemo(() => {
    const base = parseAmount(amount);
    if (!base) return null;
    return calcFee(base);
  }, [amount]);

  const freqLabel: Record<string, string> = {
    weekly: "week", monthly: "month", quarterly: "quarter", yearly: "year",
  };

  const chargingCard = hasCards && paymentMethodId !== "";
  const todayIso = new Date().toISOString().slice(0, 10);
  // When deferring the first charge, no immediate charge is collected — equivalent
  // to a trial of the first cycle.
  const firstChargeDeferred = scheduleFirst && startOn > todayIso;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLink(null);
    setLoading(true);
    const res = await fetch(`/api/clinic/customers/${customerId}/subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        amount,
        frequency,
        ...(chargingCard ? { paymentMethodId } : {}),
        ...(scheduleFirst ? { startOn, trial: firstChargeDeferred } : {}),
      }),
    });
    setLoading(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Failed to start subscription.");
      return;
    }
    if (chargingCard) {
      // Subscription started on the saved card — reset and refresh the page so
      // it shows up in the Subscriptions table.
      setAmount("");
      startTransition(() => router.refresh());
      return;
    }
    const d = (await res.json()) as { url: string };
    setLink(d.url);
  }

  return (
    <div className="card-pad">
      <h3 className="text-sm font-semibold text-slate-900 mb-3">Start subscription</h3>
      <p className="text-xs text-slate-500 mb-3">
        {chargingCard
          ? firstChargeDeferred
            ? "The first cycle bills on the scheduled date; future cycles bill automatically."
            : "The first cycle is charged to the selected card now; future cycles bill automatically."
          : "Generates a link the customer pays to start the subscription."}
        {" "}A 3.9% + $0.39 processing fee is added to each billing cycle.
      </p>
      <form onSubmit={onSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Amount (USD)</label>
            <input
              className="input"
              required
              inputMode="decimal"
              placeholder="49.99"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div>
            <label className="label">Frequency</label>
            <select
              className="input"
              value={frequency}
              onChange={(e) => setFrequency(e.target.value)}
            >
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="quarterly">Quarterly</option>
              <option value="yearly">Yearly</option>
            </select>
          </div>
        </div>

        {hasCards && (
          <div>
            <label className="label">Charge to</label>
            <select
              className="input"
              value={paymentMethodId}
              onChange={(e) => setPaymentMethodId(e.target.value)}
            >
              {methods.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              <option value="">Send a payment link instead</option>
            </select>
          </div>
        )}

        {/* Schedule first charge (mirrors master payment link) */}
        <div className="border-t border-slate-200 pt-3 space-y-2">
          <button
            type="button"
            onClick={() => setScheduleFirst((v) => !v)}
            className="flex w-full items-center justify-between gap-3 text-left"
          >
            <span className="text-sm text-slate-700">
              Schedule first charge for a future date
            </span>
            <span
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition ${scheduleFirst ? "bg-brand-600" : "bg-slate-300"}`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${scheduleFirst ? "translate-x-4" : "translate-x-1"}`}
              />
            </span>
          </button>
          {scheduleFirst && (
            <div>
              <label className="label">First subscription charge</label>
              <input
                type="date"
                className="input"
                value={startOn}
                min={todayIso}
                onChange={(e) => setStartOn(e.target.value)}
              />
              <p className="text-xs text-slate-500 mt-1">
                {firstChargeDeferred
                  ? "No charge today. The first cycle bills on the chosen date, then on schedule."
                  : "First cycle will bill today and recurring cycles on schedule."}
              </p>
            </div>
          )}
        </div>

        {feePreview && (
          <div className="text-xs text-slate-500 bg-slate-50 border border-slate-100 rounded-md px-3 py-2 space-y-1">
            <div className="flex justify-between">
              <span>Subscription</span>
              <span className="tabular-nums">{formatMoney(feePreview.totalCents - feePreview.feeCents)}</span>
            </div>
            <div className="flex justify-between">
              <span>Processing fee (3.9% + $0.39)</span>
              <span className="tabular-nums">{formatMoney(feePreview.feeCents)}</span>
            </div>
            <div className="flex justify-between font-medium text-slate-700 border-t border-slate-200 pt-1">
              <span>
                {firstChargeDeferred
                  ? `First charge ${startOn} · then per ${freqLabel[frequency] ?? frequency}`
                  : `Customer billed per ${freqLabel[frequency] ?? frequency}`}
              </span>
              <span className="tabular-nums">{formatMoney(feePreview.totalCents)}</span>
            </div>
          </div>
        )}

        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
            {error}
          </div>
        )}
        <button className="btn-primary w-full" disabled={loading}>
          {loading
            ? chargingCard
              ? "Starting…"
              : "Creating…"
            : chargingCard
              ? firstChargeDeferred
                ? feePreview
                  ? `Schedule subscription · ${formatMoney(feePreview.totalCents)} on ${startOn}`
                  : "Schedule subscription"
                : feePreview
                  ? `Start subscription · ${formatMoney(feePreview.totalCents)} now`
                  : "Start subscription"
              : "Generate subscription link"}
        </button>
      </form>
      {link && (
        <div className="mt-3 rounded-md bg-brand-50 border border-brand-100 p-3 text-sm">
          <div className="text-xs text-slate-500 mb-1">
            Share this link — first charge happens when the customer pays
            {scheduleFirst ? ` (subscription starts ${startOn})` : ""}:
          </div>
          <div className="flex items-center gap-2">
            <input readOnly value={link} className="input flex-1 font-mono text-xs" />
            <CopyButton value={link} />
          </div>
        </div>
      )}
    </div>
  );
}
