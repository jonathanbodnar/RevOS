"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function DeleteClinicButton({
  clinicId,
  clinicName,
}: {
  clinicId: string;
  clinicName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  async function handleDelete() {
    if (
      !confirm(
        `Delete clinic "${clinicName}"? This will permanently remove all associated data including customers, transactions, subscriptions, and payment links. This action cannot be undone.`,
      )
    ) {
      return;
    }

    setBusy(true);
    const res = await fetch(`/api/admin/clinics/${clinicId}`, {
      method: "DELETE",
    });
    setBusy(false);

    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      alert(d.error || "Failed to delete clinic.");
      return;
    }

    startTransition(() => router.refresh());
  }

  return (
    <button
      onClick={handleDelete}
      disabled={busy}
      className="btn-ghost text-red-600 hover:bg-red-50 text-xs disabled:opacity-40"
    >
      {busy ? "Deleting…" : "Delete"}
    </button>
  );
}
