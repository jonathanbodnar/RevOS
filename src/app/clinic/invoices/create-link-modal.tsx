"use client";

import { useState, useEffect } from "react";
import { CopyButton } from "@/components/copy-button";

type Mode = "payment" | "subscription" | "combined" | "installments";

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function addMonths(dateStr: string, months: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

function buildDefaultDates(count: number, firstToday: boolean): string[] {
  const base = firstToday ? todayStr() : addMonths(todayStr(), 1);
  return Array.from({ length: count }, (_, i) => addMonths(base, i));
}

/** Pure visual toggle — no onClick. Parent <label> handles all interaction. */
function Toggle({ checked }: { checked: boolean }) {
  return (
    <span
      className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors ${
        checked ? "bg-brand-600" : "bg-slate-200"
      }`}
    >
      <span
        className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-transform ${
          checked ? "translate-x-[18px]" : "translate-x-[3px]"
        }`}
      />
    </span>
  );
}

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

  // payment / subscription
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] = useState("monthly");
  const [trial, setTrial] = useState(false);

  // combined
  const [setupFee, setSetupFee] = useState("");
  const [subAmount, setSubAmount] = useState("");
  const [startAfterDays, setStartAfterDays] = useState("30");

  // installments — core
  const [installTotal, setInstallTotal] = useState("");
  const [installCount, setInstallCount] = useState(3);
  const [installAmounts, setInstallAmounts] = useState<string[]>(["", "", ""]);

  // installments — schedule: "frequency" or "dates" (reused as relative days)
  const [installScheduleType, setInstallScheduleType] = useState<"frequency" | "dates">("frequency");
  const [installFrequency, setInstallFrequency] = useState("monthly");
  const [installFirstToday, setInstallFirstToday] = useState(true);
  const [installDates, setInstallDates] = useState<string[]>(() =>
    buildDefaultDates(3, true),
  );
  const [installDelays, setInstallDelays] = useState<number[]>(() =>
    Array(2).fill(30),
  );

  // installments — optional concurrent subscription
  const [installIncludeSub, setInstallIncludeSub] = useState(false);
  const [installSubAmount, setInstallSubAmount] = useState("");
  const [installSubFrequency, setInstallSubFrequency] = useState("monthly");
  const [installSubStartAfterDays, setInstallSubStartAfterDays] = useState("30");

  const [description, setDescription] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);

  // Keep dates/delays array in sync with count
  useEffect(() => {
    setInstallDates((prev) => {
      if (prev.length === installCount) return prev;
      const base = installScheduleType === "dates"
        ? (prev[0] ?? todayStr())
        : (installFirstToday ? todayStr() : addMonths(todayStr(), 1));
      return Array.from({ length: installCount }, (_, i) =>
        prev[i] ?? addMonths(base, i),
      );
    });
    setInstallDelays((prev) => {
      const neededLength = installCount - 1;
      if (prev.length === neededLength) return prev;
      return Array.from({ length: neededLength }, (_, i) => prev[i] ?? 30);
    });
    setInstallAmounts((prev) => {
      if (prev.length === installCount) return prev;
      return Array.from({ length: installCount }, (_, i) => prev[i] ?? "");
    });
  }, [installCount, installScheduleType, installFirstToday]);

  // Auto-fill equal amounts when total changes and amounts are all blank
  function distributeTotal(total: string) {
    setInstallTotal(total);
    const cents = Math.round(parseFloat(total || "0") * 100);
    if (!cents) return;
    const per = (cents / installCount / 100).toFixed(2);
    setInstallAmounts(Array(installCount).fill(per));
  }

  function setDate(i: number, val: string) {
    setInstallDates((prev) => prev.map((d, j) => (j === i ? val : d)));
  }

  function setInstallAmt(i: number, val: string) {
    setInstallAmounts((prev) => prev.map((a, j) => (j === i ? val : a)));
  }

  function changeCount(n: number) {
    const clamped = Math.min(24, Math.max(2, n));
    setInstallCount(clamped);
  }

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
      body.installCount = String(installCount);
      body.installAmounts = JSON.stringify(installAmounts);
      body.installScheduleType = installScheduleType;

      if (installScheduleType === "frequency") {
        body.installFrequency = installFrequency;
        body.installFirstToday = installFirstToday ? "true" : "false";
      } else {
        body.installDelays = JSON.stringify(installDelays);
      }

      if (installIncludeSub) {
        body.installSubAmount = installSubAmount;
        body.installSubFrequency = installSubFrequency;
        if (installSubStartAfterDays) body.installSubStartAfterDays = installSubStartAfterDays;
      }
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

  const perPayment = installAmounts.every((a) => !a)
    ? installTotal
      ? (parseFloat(installTotal) / installCount).toFixed(2)
      : ""
    : null;

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="card-pad max-w-lg w-full max-h-[90vh] overflow-y-auto">
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
              {mode === "combined" && (
                <p className="text-xs text-slate-500 mt-1.5">
                  Charge a one-time setup fee today, then start a recurring subscription.
                </p>
              )}
              {mode === "installments" && (
                <p className="text-xs text-slate-500 mt-1.5">
                  Split a bill into scheduled payments, with optional subscription after the last one.
                </p>
              )}
            </div>

            {/* ── ONE-TIME ─────────────────────────────────────── */}
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

            {/* ── SUBSCRIPTION ─────────────────────────────────── */}
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
                    <select className="input" value={frequency} onChange={(e) => setFrequency(e.target.value)}>
                      <option value="weekly">Weekly</option>
                      <option value="monthly">Monthly</option>
                      <option value="quarterly">Quarterly</option>
                      <option value="yearly">Yearly</option>
                    </select>
                  </div>
                </div>
                <label className="flex items-center gap-2.5 cursor-pointer select-none">
                  <Toggle checked={trial} />
                  <input type="checkbox" checked={trial} onChange={() => setTrial(!trial)} className="sr-only" />
                  <div>
                    <span className="text-sm text-slate-700 font-medium">Free trial — no charge today</span>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Card is saved but not charged. First payment runs on next billing cycle.
                    </p>
                  </div>
                </label>
              </>
            )}

            {/* ── COMBINED ─────────────────────────────────────── */}
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
                  <p className="text-xs text-slate-500 mt-1">Leave 0 for no setup fee.</p>
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
                    <select className="input" value={frequency} onChange={(e) => setFrequency(e.target.value)}>
                      <option value="weekly">Weekly</option>
                      <option value="monthly">Monthly</option>
                      <option value="quarterly">Quarterly</option>
                      <option value="yearly">Yearly</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="label">First subscription charge (days after payment)</label>
                  <input
                    type="number"
                    className="input"
                    required
                    min={0}
                    max={365}
                    placeholder="30"
                    value={startAfterDays}
                    onChange={(e) => setStartAfterDays(e.target.value)}
                  />
                  <p className="text-xs text-slate-500 mt-1">
                    {Number(startAfterDays || 0) === 0
                      ? "Subscription starts the day the customer pays."
                      : `First subscription charge ${Number(startAfterDays || 0)} day${Number(startAfterDays) === 1 ? "" : "s"} after payment.`}
                  </p>
                </div>
              </>
            )}

            {/* ── INSTALLMENTS ─────────────────────────────────── */}
            {mode === "installments" && (
              <>
                {/* Total + count */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Total amount (USD)</label>
                    <input
                      className="input"
                      required
                      inputMode="decimal"
                      placeholder="1500.00"
                      value={installTotal}
                      onChange={(e) => distributeTotal(e.target.value)}
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
                      onChange={(e) => changeCount(Number(e.target.value))}
                    />
                  </div>
                </div>

                {perPayment && (
                  <p className="text-xs text-slate-500 -mt-1">
                    {installCount} × ${perPayment}
                  </p>
                )}

                {/* Schedule type toggle */}
                <div>
                  <label className="label">Payment schedule</label>
                  <div className="grid grid-cols-2 rounded-lg border border-slate-200 overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setInstallScheduleType("frequency")}
                      className={`py-1.5 text-xs font-medium transition-colors ${
                        installScheduleType === "frequency"
                          ? "bg-brand-600 text-white"
                          : "text-slate-600 bg-white hover:bg-slate-50"
                      }`}
                    >
                      By frequency
                    </button>
                    <button
                      type="button"
                      onClick={() => setInstallScheduleType("dates")}
                      className={`py-1.5 text-xs font-medium border-l border-slate-200 transition-colors ${
                        installScheduleType === "dates"
                          ? "bg-brand-600 text-white"
                          : "text-slate-600 bg-white hover:bg-slate-50"
                      }`}
                    >
                      Relative days
                    </button>
                  </div>
                </div>

                {/* Frequency mode */}
                {installScheduleType === "frequency" && (
                  <>
                    <div>
                      <label className="label">Frequency</label>
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
                      <Toggle checked={installFirstToday} />
                      <input
                        type="checkbox"
                        checked={installFirstToday}
                        onChange={() => setInstallFirstToday(!installFirstToday)}
                        className="sr-only"
                      />
                      <div>
                        <span className="text-sm text-slate-700 font-medium">Charge first payment today</span>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {installFirstToday
                            ? `First payment charged immediately; ${installCount - 1} more scheduled automatically.`
                            : `All ${installCount} payments scheduled (first runs tonight at 2 AM UTC).`}
                        </p>
                      </div>
                    </label>
                  </>
                )}

                {/* Relative days delay mode */}
                {installScheduleType === "dates" && (
                  <div className="space-y-3">
                    <p className="text-xs text-slate-500">
                      Specify the delay in days for each subsequent installment. First payment is charged today.
                    </p>
                    <div className="space-y-2.5">
                      {/* Payment 1 */}
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium text-slate-600 w-20 shrink-0">Payment 1</span>
                        <div className="flex-1 text-xs text-slate-500 italic bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                          Charged immediately on signup
                        </div>
                        <input
                          type="text"
                          inputMode="decimal"
                          className="input w-24"
                          placeholder={perPayment ?? "amount"}
                          value={installAmounts[0] ?? ""}
                          onChange={(e) => setInstallAmt(0, e.target.value)}
                        />
                      </div>

                      {/* Subsequent Payments */}
                      {Array.from({ length: installCount - 1 }).map((_, i) => (
                        <div key={i} className="flex items-center gap-2">
                          <span className="text-xs font-medium text-slate-600 w-20 shrink-0">Payment {i + 2}</span>
                          <div className="flex-1 flex items-center gap-2">
                            <input
                              type="number"
                              min={1}
                              max={365}
                              required
                              className="input flex-1"
                              value={installDelays[i] ?? 30}
                              onChange={(e) => {
                                const val = Math.max(1, parseInt(e.target.value) || 0);
                                setInstallDelays((prev) => prev.map((d, j) => (j === i ? val : d)));
                              }}
                            />
                            <span className="text-xs text-slate-500 w-24 shrink-0">days after #{i + 1}</span>
                          </div>
                          <input
                            type="text"
                            inputMode="decimal"
                            className="input w-24"
                            placeholder={perPayment ?? "amount"}
                            value={installAmounts[i + 1] ?? ""}
                            onChange={(e) => setInstallAmt(i + 1, e.target.value)}
                          />
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-slate-400 mt-1">
                      Leave amount blank to split total equally.
                    </p>
                  </div>
                )}

                {/* Divider */}
                <div className="border-t border-slate-100 pt-2">
                  <label className="flex items-center gap-2.5 cursor-pointer select-none">
                    <Toggle checked={installIncludeSub} />
                    <input
                      type="checkbox"
                      checked={installIncludeSub}
                      onChange={() => setInstallIncludeSub(!installIncludeSub)}
                      className="sr-only"
                    />
                    <div>
                      <span className="text-sm text-slate-700 font-medium">
                        Also start a subscription
                      </span>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Recurring charge runs alongside the installments.
                      </p>
                    </div>
                  </label>

                  {installIncludeSub && (
                    <div className="space-y-3 mt-3 pl-11">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="label">Amount (USD)</label>
                          <input
                            className="input"
                            required
                            inputMode="decimal"
                            placeholder="99.00"
                            value={installSubAmount}
                            onChange={(e) => setInstallSubAmount(e.target.value)}
                          />
                        </div>
                        <div>
                          <label className="label">Frequency</label>
                          <select
                            className="input"
                            value={installSubFrequency}
                            onChange={(e) => setInstallSubFrequency(e.target.value)}
                          >
                            <option value="weekly">Weekly</option>
                            <option value="monthly">Monthly</option>
                            <option value="quarterly">Quarterly</option>
                            <option value="yearly">Yearly</option>
                          </select>
                        </div>
                      </div>
                      <div>
                        <label className="label">First subscription charge (days after payment)</label>
                        <input
                          type="number"
                          className="input"
                          min={0}
                          max={365}
                          value={installSubStartAfterDays}
                          placeholder="30"
                          onChange={(e) => setInstallSubStartAfterDays(e.target.value)}
                        />
                        <p className="text-xs text-slate-500 mt-1">
                          {Number(installSubStartAfterDays || 0) === 0
                            ? "Subscription starts immediately (first charge in 1 billing cycle)."
                            : `First subscription charge runs ${Number(installSubStartAfterDays)} day${Number(installSubStartAfterDays) === 1 ? "" : "s"} after payment.`}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
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
                    : mode === "installments"
                    ? "Procedure financing"
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
              <button type="button" className="btn-secondary flex-1" onClick={onClose} disabled={loading}>
                Cancel
              </button>
              <button type="submit" className="btn-primary flex-1" disabled={loading}>
                {loading ? "Creating…" : "Generate link"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
