"use client";

import { useMemo, useState } from "react";
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
}: {
  customerId: string;
  methods?: { id: string; label: string }[];
}) {
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] = useState("monthly");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [link, setLink] = useState<string | null>(null);

  const feePreview = useMemo(() => {
    const base = parseAmount(amount);
    if (!base) return null;
    return calcFee(base);
  }, [amount]);

  const freqLabel: Record<string, string> = {
    weekly: "week", monthly: "month", quarterly: "quarter", yearly: "year",
  };

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLink(null);
    setLoading(true);
    const res = await fetch(`/api/clinic/customers/${customerId}/subscriptions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount, frequency }),
    });
    setLoading(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Failed to create subscription.");
      return;
    }
    const d = (await res.json()) as { url: string };
    setLink(d.url);
  }

  return (
    <div className="card-pad">
      <h3 className="text-sm font-semibold text-slate-900 mb-3">Start subscription</h3>
      <p className="text-xs text-slate-500 mb-3">
        Customer will pay the first charge immediately and then be billed automatically on the chosen schedule.
        A 3.9% + $0.39 processing fee is added to each billing cycle.
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
              <span>Customer billed per {freqLabel[frequency] ?? frequency}</span>
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
          {loading ? "Creating…" : "Generate subscription link"}
        </button>
      </form>
      {link && (
        <div className="mt-3 rounded-md bg-brand-50 border border-brand-100 p-3 text-sm">
          <div className="text-xs text-slate-500 mb-1">
            Share this link — first charge happens when the customer pays:
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
