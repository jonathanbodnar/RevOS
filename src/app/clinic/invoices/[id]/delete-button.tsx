"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DeletePaymentLinkButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    if (!confirm("Delete this payment link? The URL will stop working immediately.")) {
      return;
    }
    setBusy(true);
    const res = await fetch(`/api/clinic/payment-links/${id}`, {
      method: "DELETE",
    });
    if (!res.ok) {
      setBusy(false);
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      alert(d.error || "Failed to delete payment link.");
      return;
    }
    router.push("/clinic/invoices");
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="btn-ghost text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
    >
      {busy ? "Deleting…" : "Delete link"}
    </button>
  );
}
