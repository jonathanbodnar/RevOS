"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CopyButton } from "@/components/copy-button";
import { CreateLinkModal } from "@/app/clinic/invoices/create-link-modal";

type LinkRow = {
  id: string;
  token: string;
  url: string;
  amountCents: number;
  description: string | null;
  mode: string;
  status: string;
  metadataJson: string | null;
  createdAt: Date;
  completedAt: Date | null;
  chargeCount: number;
  subscriptionCount: number;
};

const MODE_LABELS: Record<string, string> = {
  payment: "One-time",
  subscription: "Subscription",
  combined: "Setup + sub",
  installments: "Installments",
};

const MODE_COLORS: Record<string, string> = {
  payment: "badge-indigo",
  subscription: "badge-green",
  combined: "badge-purple",
  installments: "badge-yellow",
};

function formatMoney(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function formatDate(d: Date) {
  // Use a fixed ISO-ish format to avoid server/client locale hydration mismatches.
  const dt = new Date(d);
  const mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][dt.getMonth()];
  const day = dt.getDate();
  const yr = dt.getFullYear();
  const hh = dt.getHours();
  const mm = String(dt.getMinutes()).padStart(2, "0");
  const ampm = hh >= 12 ? "PM" : "AM";
  return `${mo} ${day}, ${yr}, ${hh % 12 || 12}:${mm} ${ampm}`;
}

export function AdminPaymentLinksClient({ links }: { links: LinkRow[] }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function deleteLink(id: string) {
    if (
      !confirm(
        "Delete this global payment link? The URL will stop working immediately. Existing charges and subscriptions remain.",
      )
    ) {
      return;
    }
    setDeletingId(id);
    const res = await fetch(`/api/admin/payment-links/${id}`, {
      method: "DELETE",
    });
    setDeletingId(null);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      alert(d.error || "Failed to delete payment link.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">
            Global Payment Links
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            These links are created by super admins and visible across all
            clinics. When customers pay, charges are tracked per clinic context.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setCreating(true)}>
          + Create global link
        </button>
      </div>

      <div className="card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Description</th>
              <th>Amount</th>
              <th>Uses</th>
              <th>Created</th>
              <th className="text-right pr-4">Actions</th>
            </tr>
          </thead>
          <tbody>
            {links.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-slate-500 py-12">
                  No global payment links yet. Click &quot;Create global
                  link&quot; to generate one.
                </td>
              </tr>
            )}
            {links.map((l) => {
              const totalUses = l.chargeCount + l.subscriptionCount;
              return (
                <tr key={l.id}>
                  <td>
                    <span className={MODE_COLORS[l.mode] ?? "badge-slate"}>
                      {MODE_LABELS[l.mode] ?? l.mode}
                    </span>
                    <span className="ml-2 badge-slate text-xs">Global</span>
                  </td>
                  <td className="text-slate-600 max-w-[260px]">
                    <span
                      className="block truncate"
                      title={l.description ?? undefined}
                    >
                      {l.description || (
                        <span className="text-slate-400">—</span>
                      )}
                    </span>
                  </td>
                  <td className="font-medium tabular-nums">
                    {formatMoney(l.amountCents)}
                  </td>
                  <td>
                    {totalUses === 0 ? (
                      <span className="text-slate-400 text-sm">—</span>
                    ) : (
                      <span className="text-sm text-slate-700 tabular-nums">
                        {totalUses}
                      </span>
                    )}
                  </td>
                  <td className="text-slate-500 text-xs whitespace-nowrap">
                    {formatDate(l.createdAt)}
                  </td>
                  <td className="text-right pr-4">
                    <div className="flex items-center justify-end gap-2">
                      <CopyButton value={l.url} />
                      <button
                        type="button"
                        onClick={() => deleteLink(l.id)}
                        disabled={deletingId === l.id}
                        title="Delete link"
                        className="text-slate-400 hover:text-red-600 disabled:opacity-40 p-1"
                      >
                        <svg
                          className="w-3.5 h-3.5"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3"
                          />
                        </svg>
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {creating && (
        <CreateLinkModal
          apiEndpoint="/api/admin/payment-links"
          onClose={() => setCreating(false)}
          onCreated={() => {
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
