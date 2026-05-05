"use client";

import { useState } from "react";
import { CopyButton } from "@/components/copy-button";

export function NewInvoiceForm({
  customerId,
  email,
}: {
  customerId: string;
  email: string;
}) {
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [link, setLink] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLink(null);
    setLoading(true);
    const res = await fetch(
      `/api/clinic/customers/${customerId}/invoices`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount, description: description || undefined }),
      },
    );
    setLoading(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Failed to create payment link.");
      return;
    }
    const d = (await res.json()) as { url: string };
    setLink(d.url);
  }

  return (
    <div className="card-pad">
      <h3 className="text-sm font-semibold text-slate-900 mb-3">
        Create payment link
      </h3>
      <p className="text-xs text-slate-500 mb-3">
        Customer {email ? `(${email})` : ""} will see a hosted LunarPay page to
        pay and optionally save their card.
      </p>
      <form onSubmit={onSubmit} className="space-y-3">
        <div>
          <label className="label">Amount (USD)</label>
          <input
            className="input"
            required
            inputMode="decimal"
            placeholder="150.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
        <div>
          <label className="label">Description (optional)</label>
          <input
            className="input"
            placeholder="Lab work"
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
          {loading ? "Creating…" : "Generate link"}
        </button>
      </form>
      {link && (
        <div className="mt-3 rounded-md bg-brand-50 border border-brand-100 p-3 text-sm">
          <div className="text-xs text-slate-500 mb-1">Share this link:</div>
          <div className="flex items-center gap-2">
            <input
              readOnly
              value={link}
              className="input flex-1 font-mono text-xs"
            />
            <CopyButton value={link} />
          </div>
        </div>
      )}
    </div>
  );
}
