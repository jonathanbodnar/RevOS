"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function WipeTestDataButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleWipe() {
    if (
      !confirm(
        "⚠️ This will permanently delete ALL customers, transactions, subscriptions, installment plans, payment methods, and payment links.\n\nClinics and users are kept.\n\nType OK to continue.",
      )
    )
      return;

    setLoading(true);
    const res = await fetch("/api/admin/wipe-test-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: "WIPE" }),
    });
    setLoading(false);

    const d = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      deleted?: Record<string, number>;
    };

    if (!res.ok || !d.ok) {
      alert(d.error || "Wipe failed.");
      return;
    }

    const summary = Object.entries(d.deleted ?? {})
      .map(([k, v]) => `${v} ${k}`)
      .join(", ");
    alert(`Wiped: ${summary}`);
    router.refresh();
  }

  return (
    <button
      onClick={handleWipe}
      disabled={loading}
      className="text-xs text-red-600 border border-red-200 hover:bg-red-50 rounded-lg px-3 py-1.5 disabled:opacity-40 transition-colors"
    >
      {loading ? "Wiping…" : "Wipe all test data"}
    </button>
  );
}
