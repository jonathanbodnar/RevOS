"use client";

import { useState } from "react";
import { CopyButton } from "@/components/copy-button";

type Mode = "payment" | "subscription" | "combined" | "installments";

export function CreateLinkModal({
  onClose,
  onCreated,
  apiEndpoint = "/api/clinic/payment-links",
}: {
  onClose: () => void;
  onCreated: () => void;
  apiEndpoint?: string;
}) {
  const [mode, setMode] = useState<Mode>("payment");

  // payment / subscription mode
  const [amount, setAmount] = useState("");

  // combined mode
  const [setupFee, setSetupFee] = useState("");
  const [subAmount, setSubAmount] = useState("");
  const [startAfterDays, setStartAfterDays] = useState<string>("30");

  // installments mode
  const [installTotal, setInstallTotal] = useState("");
  const [installCount, setInstallCount] = useState("3");
  const [installFrequency, setInstallFrequency] = useState("monthly");
  const [installFirstToday, setInstallFirstToday] = useState(true);

  const [trial, setTrial] = useState(false);
  const [frequency, setFrequency] = useState("monthly");
  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const body: Record<string, string> = { mode };
    if (description) body.description = description;

    if (mode === "payment") {
      body.amount = amount;
    } else if (mode === "subscription") {
      body.amount = amount;
      body.frequency = frequency;
      if (trial) body.trial = "true";
    } else if (mode === "combined") {
      body.setupFee = setupFee || "0";
      body.subscriptionAmount = subAmount;
      body.frequency = frequency;
      body.startAfterDays = startAfterDays || "0";
    } else {
      // installments
      body.installTotal = installTotal;
      body.installCount = installCount;
      body.installFrequency = installFrequency;
      body.installFirstToday = installFirstToday ? "true" : "false";
    }

    setLoading(true);
    const res = await fetch(apiEndpoint, {
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
      <div className="card-pad max-w-md w-full max-h-[90vh] overflow-y-auto">
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
            {/* Mode selector */}
            <div>
              <label className="label">Type</label>
              <div className="grid grid-cols-4 rounded-lg border border-slate-200 overflow-hidden">
                {(["payment", "subscription", "combined", "installments"] as const).map(
                  (m, i) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMode(m)}
                      className={`py-2 text-xs font-medium transition-colors ${i > 0 ? "border-l border-slate-200" : ""} ${
                        mode === m
                          ? "bg-brand-600 text-white"
                          : "text-slate-600 bg-white hover:bg-slate-50"
                      }`}
                    >
                      {m === "payment"
                        ? "One-time"
                        : m === "subscription"
                        ? "Subscription"
                        : m === "combined"
                        ? "Setup + sub"
                        : "Installments"}
                    </button>
                  ),
                )}
              </div>
              {mode === "subscription" && (
                <p className="text-xs text-slate-500 mt-1.5">
                  First charge happens immediately; recurring plan starts after.
                </p>
              )}
              {mode === "combined" && (
                <p className="text-xs text-slate-500 mt-1.5">
                  Charge a one-time setup fee today, then start a recurring
                  subscription a fixed number of days after each customer pays.
                </p>
              )}
              {mode === "installments" && (
                <p className="text-xs text-slate-500 mt-1.5">
                  Split a fixed total into equal scheduled payments. Optionally
                  charge the first installment today.
                </p>
              )}
            </div>

            {/* Mode-specific fields */}
            {mode === "payment" && (
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
            )}

            {mode === "subscription" && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Amount (USD)</label>
                    <input
                      className="input"
                      required
                      inputMode="decimal"
                      placeholder="99.00"
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
                <label className="flex items-center gap-2.5 cursor-pointer select-none group">
                  <span
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                      trial ? "bg-brand-600" : "bg-slate-200"
                    }`}
                    onClick={() => setTrial(!trial)}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
                        trial ? "translate-x-[18px]" : "translate-x-[3px]"
                      }`}
                    />
                  </span>
                  <input
                    type="checkbox"
                    checked={trial}
                    onChange={() => setTrial(!trial)}
                    className="sr-only"
                  />
                  <div>
                    <span className="text-sm text-slate-700 font-medium">
                      Free trial — no charge today
                    </span>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Card is saved but not charged. The first recurring payment runs on the next billing cycle.
                    </p>
                  </div>
                </label>
              </>
            )}

            {mode === "combined" && (
              <>
                <div>
                  <label className="label">Setup fee (USD, charged today)</label>
                  <input
                    className="input"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={setupFee}
                    onChange={(e) => setSetupFee(e.target.value)}
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    Leave 0 for no setup fee.
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Subscription (USD)</label>
                    <input
                      className="input"
                      required
                      inputMode="decimal"
                      placeholder="99.00"
                      value={subAmount}
                      onChange={(e) => setSubAmount(e.target.value)}
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
                  <label className="label">
                    First subscription charge (days after payment)
                  </label>
                  <input
                    type="number"
                    className="input"
                    required
                    min={0}
                    max={365}
                    step={1}
                    placeholder="30"
                    value={startAfterDays}
                    onChange={(e) => setStartAfterDays(e.target.value)}
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    {Number(startAfterDays || 0) === 0
                      ? "Subscription starts the day the customer pays (charged together with the setup fee)."
                      : `First subscription charge will run ${Number(
                          startAfterDays || 0,
                        )} day${Number(startAfterDays) === 1 ? "" : "s"} after the customer pays. Only the setup fee is charged that day.`}
                  </p>
                </div>
              </>
            )}

            {mode === "installments" && (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Total amount (USD)</label>
                    <input
                      className="input"
                      required
                      inputMode="decimal"
                      placeholder="1500.00"
                      value={installTotal}
                      onChange={(e) => setInstallTotal(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="label">Number of payments</label>
                    <input
                      type="number"
                      className="input"
                      required
                      min={2}
                      max={24}
                      step={1}
                      value={installCount}
                      onChange={(e) => setInstallCount(e.target.value)}
                    />
                  </div>
                </div>
                <div>
                  <label className="label">Payment frequency</label>
                  <select
                    className="input"
                    value={installFrequency}
                    onChange={(e) => setInstallFrequency(e.target.value)}
                  >
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                    <option value="quarterly">Quarterly</option>
                    <option value="yearly">Yearly</option>
                  </select>
                </div>
                <label className="flex items-center gap-2.5 cursor-pointer select-none">
                  <span
                    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                      installFirstToday ? "bg-brand-600" : "bg-slate-200"
                    }`}
                    onClick={() => setInstallFirstToday(!installFirstToday)}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
                        installFirstToday ? "translate-x-[18px]" : "translate-x-[3px]"
                      }`}
                    />
                  </span>
                  <input
                    type="checkbox"
                    checked={installFirstToday}
                    onChange={() => setInstallFirstToday(!installFirstToday)}
                    className="sr-only"
                  />
                  <div>
                    <span className="text-sm text-slate-700 font-medium">
                      Charge first payment today
                    </span>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {installFirstToday
                        ? `First payment charged immediately; remaining ${Math.max(0, Number(installCount || 0) - 1)} scheduled automatically.`
                        : `All ${installCount || "N"} payments deferred to schedule (first runs tonight at 2 AM UTC).`}
                    </p>
                  </div>
                </label>
              </>
            )}

            {/* Description */}
            <div>
              <label className="label">Description (optional)</label>
              <input
                className="input"
                placeholder={
                  mode === "subscription"
                    ? "Monthly wellness plan"
                    : mode === "combined"
                    ? "Onboarding + monthly plan"
                    : "Lab work"
                }
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
