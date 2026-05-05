"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function CancelSubscriptionButton({
  subscriptionId,
}: {
  subscriptionId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    if (!confirm("Cancel this subscription? No further charges will be made."))
      return;
    setBusy(true);
    const res = await fetch(
      `/api/clinic/subscriptions/${subscriptionId}/cancel`,
      { method: "POST" },
    );
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      alert(d.error || "Cancel failed.");
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <button
      className="btn-ghost text-red-600 hover:bg-red-50"
      onClick={onClick}
      disabled={busy || pending}
    >
      Cancel
    </button>
  );
}
