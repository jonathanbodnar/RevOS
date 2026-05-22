"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CopyButton } from "@/components/copy-button";
import { CreateLinkModal } from "./create-link-modal";

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
  isGlobal?: boolean;
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
  return new Date(d).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function PaymentLinksClient({
  links,
  clinicId,
  isSuperAdmin = false,
}: {
  links: LinkRow[];
  clinicId: string;
  isSuperAdmin?: boolean;
}) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function deleteLink(id: string) {
    if (
      !confirm(
        "Delete this payment link? The URL will stop working immediately. Existing charges and subscriptions remain.",
      )
    ) {
      return;
    }
    setDeletingId(id);
    const res = await fetch(`/api/clinic/payment-links/${id}`, {
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

  const filtered = links.filter((l) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (l.description ?? "").toLowerCase().includes(q);
  });

  return (
    <div className="space-y-5">
      {/* Page header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">
            Payment Links
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Reusable links — share with any number of patients. Each payment
            creates a customer profile and saves the card for future charges.
          </p>
        </div>
        {isSuperAdmin && (
          <button className="btn-primary" onClick={() => setCreating(true)}>
            + Create link
          </button>
        )}
      </div>

      {/* Search */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            className="input pl-8"
            placeholder="Search description…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Description</th>
              <th>Amount</th>
              <th>Payments</th>
              <th>Created</th>
              <th className="text-right pr-4">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-slate-500 py-12">
                  {search
                    ? "No payment links match your filter."
                    : 'No payment links yet. Click "Create link" to generate one.'}
                </td>
              </tr>
            )}
            {filtered.map((l) => {
              const totalUses = l.chargeCount + l.subscriptionCount;
              return (
                <tr
                  key={l.id}
                  className="cursor-pointer"
                  onClick={() => router.push(`/clinic/invoices/${l.id}`)}
                >
                  <td>
                    <span className={MODE_COLORS[l.mode] ?? "badge-slate"}>
                      {MODE_LABELS[l.mode] ?? l.mode}
                    </span>
                    {(() => {
                      const meta = l.metadataJson ? (JSON.parse(l.metadataJson) as Record<string, unknown>) : {};
                      return meta.trial ? (
                        <span className="ml-2 badge-slate text-xs">Trial</span>
                      ) : null;
                    })()}
                    {l.isGlobal && (
                      <span className="ml-2 badge-slate text-xs">Global</span>
                    )}
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
                  <td
                    className="text-right pr-4"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex items-center justify-end gap-2">
                      <CopyButton
                        value={
                          l.isGlobal ? `${l.url}?c=${clinicId}` : l.url
                        }
                      />
                      <Link
                        href={`/clinic/invoices/${l.id}`}
                        className="btn-ghost text-xs px-2 py-1"
                      >
                        View →
                      </Link>
                      {isSuperAdmin && !l.isGlobal && (
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
                      )}
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
          onClose={() => setCreating(false)}
          onCreated={() => {
            router.refresh();
          }}
        />
      )}
    </div>
  );
}
