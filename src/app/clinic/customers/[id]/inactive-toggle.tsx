"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function InactiveToggleButton({
  customerId,
  isActive,
}: {
  customerId: string;
  isActive: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  async function toggle() {
    const next = !isActive;
    const ok = confirm(
      next
        ? "Mark this patient active again? They will reappear in the default customer list."
        : "Mark this patient inactive? They will be hidden from the default customer list but kept for history and reporting.",
    );
    if (!ok) return;
    setBusy(true);
    const res = await fetch(`/api/clinic/customers/${customerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: next }),
    });
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      alert(d.error || "Failed to update status.");
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <button
      type="button"
      className="btn-secondary text-xs"
      onClick={toggle}
      disabled={busy || pending}
    >
      {busy ? "Saving…" : isActive ? "Mark inactive" : "Mark active"}
    </button>
  );
}
