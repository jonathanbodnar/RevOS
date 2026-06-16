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
  existingUpdateCardUrl,
  canRemoveCard = false,
  canReassign = false,
  otherCustomers = [],
}: {
  customerId: string;
  methods: MethodView[];
  existingUpdateCardUrl: string | null;
  canRemoveCard?: boolean;
  canReassign?: boolean;
  otherCustomers?: { id: string; label: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null);
  const [reassignId, setReassignId] = useState<string | null>(null);

  // Update-card link state
  const [updateCardUrl, setUpdateCardUrl] = useState<string | null>(
    existingUpdateCardUrl,
  );
  const [linkLoading, setLinkLoading] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  async function getOrCreateLink() {
    setLinkError(null);
    setLinkLoading(true);
    const res = await fetch(
      `/api/clinic/customers/${customerId}/save-card-link`,
      { method: "POST" },
    );
    setLinkLoading(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setLinkError(d.error || "Failed to create link.");
      return;
    }
    const d = (await res.json()) as { url: string };
    setUpdateCardUrl(d.url);
  }

  async function rotateLink() {
    if (
      !confirm(
        "Generate a new update-card link? The previous link will stop working.",
      )
    )
      return;
    setLinkLoading(true);
    setLinkError(null);
    // DELETE invalidates the existing open link, then POST mints a fresh one.
    await fetch(`/api/clinic/customers/${customerId}/save-card-link`, {
      method: "DELETE",
    });
    const res = await fetch(
      `/api/clinic/customers/${customerId}/save-card-link`,
      { method: "POST" },
    );
    setLinkLoading(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setLinkError(d.error || "Failed to regenerate link.");
      return;
    }
    const d = (await res.json()) as { url: string };
    setUpdateCardUrl(d.url);
  }

  async function setDefault(pmId: string) {
    setSettingDefaultId(pmId);
    const res = await fetch(
      `/api/clinic/customers/${customerId}/payment-methods/${pmId}`,
      { method: "PATCH" },
    );
    setSettingDefaultId(null);
    if (!res.ok) {
      alert("Failed to set default.");
      return;
    }
    startTransition(() => router.refresh());
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
          <button
            className="btn-primary"
            onClick={() => setAdding(true)}
          >
            + Add card
          </button>
        </div>
      </div>

      {methods.length === 0 ? (
        <div className="text-sm text-slate-500 text-center py-6">
          No payment methods on file.
        </div>
      ) : (
        <ul className="divide-y divide-slate-100 mb-4">
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
                  {m.expMonth && m.expYear
                    ? ` · exp ${m.expMonth}/${m.expYear}`
                    : ""}
                </div>
              </div>
              <div className="flex items-center gap-2">
                {!m.isDefault && (
                  <button
                    className="btn-ghost text-xs px-2 py-1"
                    disabled={pending || settingDefaultId === m.id}
                    onClick={() => setDefault(m.id)}
                  >
                    {settingDefaultId === m.id ? "Saving…" : "Set default"}
                  </button>
                )}
                {canReassign && otherCustomers.length > 0 && (
                  <button
                    className="btn-ghost text-xs px-2 py-1"
                    disabled={pending}
                    onClick={() => setReassignId(m.id)}
                  >
                    Reassign
                  </button>
                )}
                {canRemoveCard && (
                  <button
                    className="btn-ghost text-red-600 hover:bg-red-50 text-xs"
                    disabled={pending}
                    onClick={() => remove(m.id)}
                  >
                    Remove
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Update-card link section */}
      <div className="border-t border-slate-100 pt-4">
        <div className="flex items-center justify-between mb-2">
          <div>
            <p className="text-xs font-semibold text-slate-700">
              Update card link
            </p>
            <p className="text-xs text-slate-500">
              Send this to the customer so they can securely add a new card on
              file.
            </p>
          </div>
          {updateCardUrl ? (
            <button
              className="btn-ghost text-xs px-2 py-1"
              onClick={rotateLink}
              disabled={linkLoading}
            >
              Regenerate
            </button>
          ) : (
            <button
              className="btn-secondary text-xs"
              onClick={getOrCreateLink}
              disabled={linkLoading}
            >
              {linkLoading ? "Generating…" : "Generate link"}
            </button>
          )}
        </div>

        {linkError && (
          <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded px-3 py-2 mb-2">
            {linkError}
          </div>
        )}

        {updateCardUrl && (
          <div className="flex items-center gap-2 rounded-md bg-slate-50 border border-slate-200 px-3 py-2">
            <input
              readOnly
              value={updateCardUrl}
              className="flex-1 bg-transparent font-mono text-xs text-slate-700 outline-none truncate"
            />
            <CopyButton value={updateCardUrl} />
          </div>
        )}
      </div>

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

      {reassignId && (
        <ReassignModal
          customerId={customerId}
          pmId={reassignId}
          method={methods.find((m) => m.id === reassignId) ?? null}
          otherCustomers={otherCustomers}
          onClose={() => setReassignId(null)}
          onDone={(targetId) => {
            setReassignId(null);
            // The card now lives on another profile — send the admin there.
            startTransition(() => router.push(`/clinic/customers/${targetId}`));
          }}
        />
      )}
    </div>
  );
}

function ReassignModal({
  customerId,
  pmId,
  method,
  otherCustomers,
  onClose,
  onDone,
}: {
  customerId: string;
  pmId: string;
  method: MethodView | null;
  otherCustomers: { id: string; label: string }[];
  onClose: () => void;
  onDone: (targetCustomerId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filtered = query.trim()
    ? otherCustomers.filter((c) =>
        c.label.toLowerCase().includes(query.trim().toLowerCase()),
      )
    : otherCustomers;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    setError(null);
    setBusy(true);
    const res = await fetch(
      `/api/clinic/customers/${customerId}/payment-methods/${pmId}/reassign`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetCustomerId: target }),
      },
    );
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Failed to reassign.");
      return;
    }
    onDone(target);
  }

  const label = method
    ? `${method.sourceType === "ach" ? "Bank" : "Card"} •••• ${method.lastDigits ?? "????"}`
    : "this card";

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="card-pad max-w-md w-full text-left">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-base font-semibold text-slate-900">
            Reassign saved card
          </h2>
          <button
            className="btn-ghost p-1 text-slate-400 hover:text-slate-600"
            onClick={() => !busy && onClose()}
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="text-xs text-slate-500 mb-4">
          Move <span className="font-medium text-slate-700">{label}</span> to
          another patient in this clinic. The card keeps charging the same
          underlying account — future charges are just attributed to the new
          patient.
        </p>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="label">Search patients</label>
            <input
              className="input mb-2"
              placeholder="Name or email…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              className="input"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              size={6}
            >
              {filtered.length === 0 && <option disabled>No matches</option>}
              {filtered.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
              {error}
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-secondary flex-1"
              onClick={() => !busy && onClose()}
              disabled={busy}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary flex-1"
              disabled={busy || !target}
            >
              {busy ? "Moving…" : "Reassign card"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
