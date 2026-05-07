"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function DeleteCustomerButton({
  customerId,
  customerName,
}: {
  customerId: string;
  customerName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  async function handleDelete() {
    if (
      !confirm(
        `Delete customer "${customerName}"? This will permanently remove all associated payment methods, transactions, and subscriptions. This action cannot be undone.`,
      )
    ) {
      return;
    }

    setBusy(true);
    const res = await fetch(`/api/clinic/customers/${customerId}`, {
      method: "DELETE",
    });
    setBusy(false);

    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      alert(d.error || "Failed to delete customer.");
      return;
    }

    startTransition(() => router.push("/clinic/customers"));
  }

  return (
    <button
      onClick={handleDelete}
      disabled={busy}
      className="btn-ghost text-red-600 hover:bg-red-50 text-xs disabled:opacity-40"
    >
      {busy ? "Deleting…" : "Delete customer"}
    </button>
  );
}
