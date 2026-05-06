"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CopyButton } from "@/components/copy-button";
import { CreateLinkModal } from "./create-link-modal";

type SessionRow = {
  id: string;
  customer: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
  } | null;
  mode: string;
  description: string | null;
  amountCents: number;
  status: string;
  createdAt: Date;
  url: string;
};


type Tab = "all" | "open" | "completed" | "expired";

const MODE_LABELS: Record<string, string> = {
  payment: "One-time",
  subscription: "Subscription",
  installments: "Installments",
  save_card: "Save card",
};

const MODE_COLORS: Record<string, string> = {
  payment: "badge-indigo",
  subscription: "badge-green",
  installments: "badge-yellow",
  save_card: "badge-slate",
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

function customerName(c: SessionRow["customer"]): string {
  if (!c) return "—";
  return (
    [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email || "Customer"
  );
}

export function PaymentLinksClient({
  sessions,
}: {
  sessions: SessionRow[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("all");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);

  const counts: Record<Tab, number> = {
    all: sessions.length,
    open: sessions.filter((s) => s.status === "open").length,
    completed: sessions.filter((s) => s.status === "completed").length,
    expired: sessions.filter((s) => s.status === "expired").length,
  };

  const filtered = sessions.filter((s) => {
    if (tab !== "all" && s.status !== tab) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      const name = customerName(s.customer).toLowerCase();
      const email = s.customer?.email?.toLowerCase() ?? "";
      const desc = s.description?.toLowerCase() ?? "";
      if (!name.includes(q) && !email.includes(q) && !desc.includes(q)) {
        return false;
      }
    }
    return true;
  });

  const tabs: Tab[] = ["all", "open", "completed", "expired"];

  return (
    <div className="space-y-5">
      {/* Page header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">
            Payment Links
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Hosted checkout links sent to patients for payment.
          </p>
        </div>
        <button
          className="btn-primary"
          onClick={() => setCreating(true)}
        >
          + Create link
        </button>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Status tabs */}
        <div className="flex rounded-lg border border-slate-200 bg-white overflow-hidden text-sm">
          {tabs.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex items-center gap-1.5 px-3.5 py-2 font-medium transition-colors ${
                tab === t
                  ? "bg-brand-600 text-white"
                  : "text-slate-600 hover:bg-slate-50"
              } ${t !== "all" ? "border-l border-slate-200" : ""}`}
            >
              <span className="capitalize">{t}</span>
              <span
                className={`text-xs rounded-full px-1.5 py-0.5 font-semibold ${
                  tab === t
                    ? "bg-white/20 text-white"
                    : "bg-slate-100 text-slate-500"
                }`}
              >
                {counts[t]}
              </span>
            </button>
          ))}
        </div>

        {/* Search */}
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
            placeholder="Search customer or description…"
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
              <th>Customer</th>
              <th>Type</th>
              <th>Description</th>
              <th>Amount</th>
              <th>Status</th>
              <th>Created</th>
              <th className="text-right pr-4">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td
                  colSpan={7}
                  className="text-center text-slate-500 py-12"
                >
                  {search || tab !== "all"
                    ? "No payment links match your filter."
                    : 'No payment links yet. Click "Create link" to generate one.'}
                </td>
              </tr>
            )}
            {filtered.map((s) => (
              <tr
                key={s.id}
                className="cursor-pointer"
                onClick={() => router.push(`/clinic/invoices/${s.id}`)}
              >
                <td>
                  {s.customer ? (
                    <Link
                      href={`/clinic/customers/${s.customer.id}`}
                      className="text-brand-600 hover:underline font-medium"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {customerName(s.customer)}
                    </Link>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
                <td>
                  <span className={MODE_COLORS[s.mode] ?? "badge-slate"}>
                    {MODE_LABELS[s.mode] ?? s.mode}
                  </span>
                </td>
                <td className="text-slate-600 max-w-[200px]">
                  <span
                    className="block truncate"
                    title={s.description ?? undefined}
                  >
                    {s.description || (
                      <span className="text-slate-400">—</span>
                    )}
                  </span>
                </td>
                <td className="font-medium tabular-nums">
                  {formatMoney(s.amountCents)}
                </td>
                <td>
                  <span
                    className={
                      s.status === "completed"
                        ? "badge-green"
                        : s.status === "expired"
                          ? "badge-slate"
                          : "badge-yellow"
                    }
                  >
                    {s.status}
                  </span>
                </td>
                <td className="text-slate-500 text-xs whitespace-nowrap">
                  {formatDate(s.createdAt)}
                </td>
                <td
                  className="text-right pr-4"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-end gap-2">
                    {s.status === "open" && (
                      <CopyButton value={s.url} />
                    )}
                    <Link
                      href={`/clinic/invoices/${s.id}`}
                      className="btn-ghost text-xs px-2 py-1"
                    >
                      View →
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
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
