"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function NewSubscriptionForm({
  customerId,
  methods,
}: {
  customerId: string;
  methods: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] = useState("monthly");
  const [startOn, setStartOn] = useState("");
  const [paymentMethodId, setPaymentMethodId] = useState(methods[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);

  const disabled = methods.length === 0;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch(
      `/api/clinic/customers/${customerId}/subscriptions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentMethodId,
          amount,
          frequency,
          startOn: startOn || undefined,
        }),
      },
    );
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Failed to create subscription.");
      return;
    }
    setAmount("");
    setStartOn("");
    startTransition(() => router.refresh());
  }

  return (
    <div className="card-pad">
      <h3 className="text-sm font-semibold text-slate-900 mb-3">Subscription</h3>
      {disabled ? (
        <p className="text-sm text-slate-500">Add a payment method first.</p>
      ) : (
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
          <div>
            <label className="label">Payment method</label>
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
            </select>
          </div>
          <div>
            <label className="label">Start on (optional)</label>
            <input
              type="date"
              className="input"
              value={startOn}
              onChange={(e) => setStartOn(e.target.value)}
            />
          </div>
          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
              {error}
            </div>
          )}
          <button className="btn-primary w-full" disabled={pending}>
            {pending ? "Creating…" : "Start subscription"}
          </button>
        </form>
      )}
    </div>
  );
}
