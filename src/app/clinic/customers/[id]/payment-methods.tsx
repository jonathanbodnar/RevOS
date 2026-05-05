"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { AddCardModal } from "./add-card-modal";
import { CopyButton } from "@/components/copy-button";

type MethodView = {
  id: string;
  lunarpayPaymentMethodId: number;
  sourceType: string;
  lastDigits: string | null;
  nameHolder: string | null;
  isDefault: boolean;
  expMonth: string | null;
  expYear: string | null;
};

export function PaymentMethods({
  customerId,
  methods,
}: {
  customerId: string;
  methods: MethodView[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [linkUrl, setLinkUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function createAddCardLink() {
    setError(null);
    setLinkUrl(null);
    const res = await fetch(
      `/api/clinic/customers/${customerId}/save-card-link`,
      { method: "POST" },
    );
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Failed to create link.");
      return;
    }
    const d = (await res.json()) as { url: string };
    setLinkUrl(d.url);
  }

  async function remove(pmId: string) {
    if (!confirm("Remove this payment method?")) return;
    const res = await fetch(
      `/api/clinic/customers/${customerId}/payment-methods/${pmId}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      alert("Failed to remove.");
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div className="card-pad">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-900">
          Payment methods
        </h3>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={createAddCardLink}>
            Send link to customer
          </button>
          <button className="btn-primary" onClick={() => setAdding(true)}>
            Add card
          </button>
        </div>
      </div>

      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2 mb-3">
          {error}
        </div>
      )}

      {linkUrl && (
        <div className="mb-3 rounded-md bg-brand-50 border border-brand-100 p-3 text-sm">
          <div className="text-xs text-slate-500 mb-1">
            Share this link with the customer to add their payment info:
          </div>
          <div className="flex items-center gap-2">
            <input readOnly value={linkUrl} className="input flex-1 font-mono text-xs" />
            <CopyButton value={linkUrl} />
          </div>
        </div>
      )}

      {methods.length === 0 ? (
        <div className="text-sm text-slate-500 text-center py-6">
          No payment methods on file.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {methods.map((m) => (
            <li
              key={m.id}
              className="flex items-center justify-between py-3"
            >
              <div>
                <div className="text-sm font-medium text-slate-900">
                  {m.sourceType === "ach" ? "Bank account" : "Card"} ••••{" "}
                  {m.lastDigits ?? "????"}
                  {m.isDefault && (
                    <span className="badge-indigo ml-2">Default</span>
                  )}
                </div>
                <div className="text-xs text-slate-500">
                  {m.nameHolder || "—"}
                  {m.expMonth && m.expYear ? ` · exp ${m.expMonth}/${m.expYear}` : ""}
                </div>
              </div>
              <button
                className="btn-ghost text-red-600 hover:bg-red-50"
                disabled={pending}
                onClick={() => remove(m.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <AddCardModal
          customerId={customerId}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            startTransition(() => router.refresh());
          }}
        />
      )}
    </div>
  );
}
