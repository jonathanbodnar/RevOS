"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Hold = {
  id: string;
  amountCents: number;
  status: string;
  description: string | null;
  createdAt: Date;
};

type PaymentMethod = {
  id: string;
  label: string;
  sourceType: string;
};

function formatMoney(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function formatDate(d: Date) {
  return new Date(d).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function HoldsSection({
  customerId,
  holds,
  methods,
}: {
  customerId: string;
  holds: Hold[];
  methods: PaymentMethod[];
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [selectedPm, setSelectedPm] = useState(
    methods.find((m) => m.sourceType === "cc")?.id ?? "",
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const ccMethods = methods.filter((m) => m.sourceType === "cc");

  async function placeHold(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setSaving(true);
    const res = await fetch(`/api/clinic/customers/${customerId}/holds`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount, paymentMethodId: selectedPm, description }),
    });
    setSaving(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setErr(d.error || "Failed to place hold.");
      return;
    }
    setAdding(false);
    setAmount("");
    setDescription("");
    router.refresh();
  }

  async function capture(holdId: string, holdAmountCents: number) {
    const input = window.prompt(
      `Capture amount (leave blank to capture full ${formatMoney(holdAmountCents)}):`,
    );
    if (input === null) return; // cancelled
    const res = await fetch(
      `/api/clinic/customers/${customerId}/holds/${holdId}/capture`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: input || undefined }),
      },
    );
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      alert(d.error || "Capture failed.");
      return;
    }
    router.refresh();
  }

  async function voidHold(holdId: string) {
    if (!confirm("Release this hold? The funds will be returned to the card."))
      return;
    const res = await fetch(
      `/api/clinic/customers/${customerId}/holds/${holdId}/void`,
      { method: "POST" },
    );
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      alert(d.error || "Void failed.");
      return;
    }
    router.refresh();
  }

  const activeHolds = holds.filter((h) => h.status === "authorized");
  const pastHolds = holds.filter((h) => h.status !== "authorized");

  return (
    <div className="card-pad space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-slate-900">Holds</h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Authorize funds without charging. Capture or void within 7 days.
            Credit cards only.
          </p>
        </div>
        {ccMethods.length > 0 && !adding && (
          <button
            className="btn-secondary text-xs"
            onClick={() => {
              setAdding(true);
              setErr(null);
            }}
          >
            + Place hold
          </button>
        )}
      </div>

      {adding && (
        <form onSubmit={placeHold} className="border border-slate-200 rounded-lg p-4 space-y-3 bg-slate-50">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Hold amount (USD)</label>
              <input
                className="input"
                required
                inputMode="decimal"
                placeholder="200.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div>
              <label className="label">Card</label>
              <select
                className="input"
                value={selectedPm}
                onChange={(e) => setSelectedPm(e.target.value)}
              >
                {ccMethods.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="label">Description (optional)</label>
            <input
              className="input"
              placeholder="Visit deposit — Dr. Smith, May 20"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          {err && (
            <p className="text-xs text-red-600">{err}</p>
          )}
          <p className="text-xs text-slate-500">
            Funds will be reserved on the card but not moved until you capture.
            The hold expires automatically in 7 days if not captured.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-secondary flex-1 text-xs"
              onClick={() => setAdding(false)}
              disabled={saving}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary flex-1 text-xs"
              disabled={saving}
            >
              {saving ? "Placing hold…" : "Place hold"}
            </button>
          </div>
        </form>
      )}

      {ccMethods.length === 0 && (
        <p className="text-xs text-slate-500">
          No credit cards on file. Add a card to place a hold.
        </p>
      )}

      {activeHolds.length > 0 && (
        <div>
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">
            Active holds
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Amount</th>
                <th>Description</th>
                <th>Placed</th>
                <th className="text-right pr-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {activeHolds.map((h) => (
                <tr key={h.id}>
                  <td>
                    <span className="font-medium">{formatMoney(h.amountCents)}</span>
                    <span className="ml-2 badge-yellow text-xs">hold</span>
                  </td>
                  <td className="text-slate-600">{h.description || "—"}</td>
                  <td className="text-xs text-slate-500">{formatDate(h.createdAt)}</td>
                  <td className="text-right pr-3">
                    <div className="flex items-center justify-end gap-2">
                      <button
                        className="btn-primary text-xs px-2 py-1"
                        onClick={() => capture(h.id, h.amountCents)}
                      >
                        Capture
                      </button>
                      <button
                        className="text-xs text-slate-400 hover:text-red-600"
                        onClick={() => voidHold(h.id)}
                      >
                        Void
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pastHolds.length > 0 && (
        <div>
          <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">
            Past holds
          </p>
          <table className="table">
            <thead>
              <tr>
                <th>Amount</th>
                <th>Status</th>
                <th>Description</th>
                <th>Date</th>
              </tr>
            </thead>
            <tbody>
              {pastHolds.map((h) => (
                <tr key={h.id}>
                  <td className="font-medium">{formatMoney(h.amountCents)}</td>
                  <td>
                    <span className={h.status === "paid" ? "badge-green" : "badge-slate"}>
                      {h.status === "paid" ? "captured" : h.status}
                    </span>
                  </td>
                  <td className="text-slate-600">{h.description || "—"}</td>
                  <td className="text-xs text-slate-500">{formatDate(h.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {holds.length === 0 && !adding && ccMethods.length > 0 && (
        <p className="text-sm text-slate-400 text-center py-4">
          No holds placed yet.
        </p>
      )}
    </div>
  );
}
