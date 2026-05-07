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
}: {
  customerId: string;
  methods: MethodView[];
  existingUpdateCardUrl: string | null;
  canRemoveCard?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [adding, setAdding] = useState(false);
  const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null);

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
    </div>
  );
}
