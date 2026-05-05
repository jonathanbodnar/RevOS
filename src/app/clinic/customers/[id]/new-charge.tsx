"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

export function NewChargeForm({
  customerId,
  methods,
}: {
  customerId: string;
  methods: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [loading, setLoading] = useState(false);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [paymentMethodId, setPaymentMethodId] = useState(methods[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);

  // Sync when methods arrive after a card is added on the same page load
  useEffect(() => {
    if (!paymentMethodId && methods[0]?.id) setPaymentMethodId(methods[0].id);
  }, [methods, paymentMethodId]);

  const disabled = methods.length === 0;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/clinic/customers/${customerId}/charges`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          paymentMethodId,
          amount,
          description: description || undefined,
        }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        setError(d.error || "Charge failed.");
        return;
      }
      setAmount("");
      setDescription("");
      startTransition(() => router.refresh());
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card-pad">
      <h3 className="text-sm font-semibold text-slate-900 mb-3">One-time charge</h3>
      {disabled ? (
        <p className="text-sm text-slate-500">
          Add a payment method first.
        </p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-3">
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
            <label className="label">Description (optional)</label>
            <input
              className="input"
              placeholder="Visit copay"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
              {error}
            </div>
          )}
          <button className="btn-primary w-full" disabled={loading}>
            {loading ? "Processing…" : "Charge"}
          </button>
        </form>
      )}
    </div>
  );
}
