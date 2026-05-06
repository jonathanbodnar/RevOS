"use client";

import { useState } from "react";
import { CopyButton } from "@/components/copy-button";

type Mode = "payment" | "subscription";

export function CreateLinkModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [mode, setMode] = useState<Mode>("payment");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [frequency, setFrequency] = useState("monthly");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const body: Record<string, string> = { amount, mode };
    if (description) body.description = description;
    if (mode === "subscription") body.frequency = frequency;

    const res = await fetch("/api/clinic/payment-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    setLoading(false);

    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Failed to create payment link.");
      return;
    }

    const d = (await res.json()) as { url: string };
    setGeneratedUrl(d.url);
    onCreated();
  }

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card-pad max-w-md w-full">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-base font-semibold text-slate-900">
            Create payment link
          </h2>
          <button
            className="btn-ghost p-1 text-slate-400 hover:text-slate-600"
            onClick={onClose}
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {generatedUrl ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-emerald-700 bg-emerald-50 rounded-lg px-4 py-3 text-sm font-medium">
              <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Payment link created
            </div>
            <div>
              <label className="label">Share this link with anyone</label>
              <div className="flex items-center gap-2">
                <input readOnly value={generatedUrl} className="input flex-1 font-mono text-xs" />
                <CopyButton value={generatedUrl} />
              </div>
            </div>
            <p className="text-xs text-slate-500">
              When someone pays, they&apos;ll be automatically added as a customer and their card saved.
            </p>
            <button className="btn-secondary w-full" onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            {/* Mode toggle */}
            <div>
              <label className="label">Type</label>
              <div className="flex rounded-lg border border-slate-200 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setMode("payment")}
                  className={`flex-1 py-2 text-sm font-medium transition-colors ${
                    mode === "payment"
                      ? "bg-brand-600 text-white"
                      : "text-slate-600 bg-white hover:bg-slate-50"
                  }`}
                >
                  One-time payment
                </button>
                <button
                  type="button"
                  onClick={() => setMode("subscription")}
                  className={`flex-1 py-2 text-sm font-medium transition-colors border-l border-slate-200 ${
                    mode === "subscription"
                      ? "bg-brand-600 text-white"
                      : "text-slate-600 bg-white hover:bg-slate-50"
                  }`}
                >
                  Subscription
                </button>
              </div>
              {mode === "subscription" && (
                <p className="text-xs text-slate-500 mt-1.5">
                  First charge happens immediately; LunarPay auto-creates the recurring plan.
                </p>
              )}
            </div>

            {/* Amount + Frequency */}
            <div className={mode === "subscription" ? "grid grid-cols-2 gap-3" : ""}>
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
              {mode === "subscription" && (
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
              )}
            </div>

            {/* Description */}
            <div>
              <label className="label">Description (optional)</label>
              <input
                className="input"
                placeholder={mode === "subscription" ? "Monthly wellness plan" : "Lab work"}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            {error && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
                {error}
              </div>
            )}

            <div className="flex gap-3 pt-1">
              <button
                type="button"
                className="btn-secondary flex-1"
                onClick={onClose}
                disabled={loading}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn-primary flex-1"
                disabled={loading}
              >
                {loading ? "Creating…" : "Generate link"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
