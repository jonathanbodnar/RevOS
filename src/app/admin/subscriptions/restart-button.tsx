"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type Card = { id: string; label: string; isDefault: boolean; expired: boolean };

/**
 * Restart a subscription that stopped on a dead card.
 *
 * LunarPay cannot un-cancel, so this creates a replacement. It never charges
 * today — the operator picks the date billing resumes, and the dialog says so,
 * because the underlying create path bills immediately for a same-day start.
 */
export function RestartButton({
  subscriptionId,
  patient,
  amountLabel,
  frequency,
  cards,
  defaultStartOn,
}: {
  subscriptionId: string;
  patient: string;
  amountLabel: string;
  frequency: string;
  cards: Card[];
  defaultStartOn: string;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usable = cards.filter((c) => !c.expired);
  const [cardId, setCardId] = useState(
    usable.find((c) => c.isDefault)?.id ?? usable[0]?.id ?? "",
  );
  const [startOn, setStartOn] = useState(defaultStartOn);

  async function submit() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/admin/subscriptions/${subscriptionId}/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paymentMethodId: cardId, startOn }),
    });
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Restart failed.");
      return;
    }
    setOpen(false);
    startTransition(() => router.refresh());
  }

  if (!open) {
    return (
      <button
        className="btn-ghost text-xs px-2 py-1"
        onClick={() => setOpen(true)}
        disabled={cards.length === 0}
        title={cards.length === 0 ? "No card on file" : "Restart this subscription"}
      >
        Restart
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
      <div className="card-pad w-full max-w-md bg-white space-y-3">
        <h3 className="text-sm font-semibold text-slate-900">
          Restart subscription — {patient}
        </h3>
        <p className="text-xs text-slate-500">
          {amountLabel} {frequency}. This creates a new subscription (the old one
          was cancelled at the processor and cannot be reopened).{" "}
          <strong>No charge is made today</strong> — billing resumes on the date
          below. To collect a missed payment, take a one-off charge on the
          patient&apos;s profile.
        </p>

        {usable.length === 0 ? (
          <p className="text-xs text-red-600">
            Every card on file is expired. Add a working card before restarting.
          </p>
        ) : (
          <>
            <div>
              <label className="label" htmlFor="restart-card">
                Card to bill
              </label>
              <select
                id="restart-card"
                className="input w-full text-sm"
                value={cardId}
                onChange={(e) => setCardId(e.target.value)}
              >
                {usable.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                    {c.isDefault ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="restart-date">
                First payment date
              </label>
              <input
                id="restart-date"
                type="date"
                className="input w-44"
                value={startOn}
                onChange={(e) => setStartOn(e.target.value)}
              />
            </div>
          </>
        )}

        {error && <p className="text-xs text-red-600">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-ghost text-xs px-3 py-1" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button
            className="btn-primary text-xs px-3 py-1"
            onClick={submit}
            disabled={busy || !cardId || usable.length === 0}
          >
            {busy ? "Restarting…" : "Restart"}
          </button>
        </div>
      </div>
    </div>
  );
}
