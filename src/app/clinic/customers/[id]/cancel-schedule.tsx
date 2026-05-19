"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * Cancels the future payments on an installment plan. Already-paid
 * installments stay paid — those are refunded individually from the
 * customer's Transactions list (each paid installment appears there as
 * its own Charge with a Refund button).
 */
export function CancelScheduleButton({
  scheduleId,
}: {
  scheduleId: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    if (
      !confirm(
        "Cancel this installment plan? Future scheduled payments will not be charged. Payments already collected stay — refund those individually from the Transactions list.",
      )
    )
      return;
    setBusy(true);
    const res = await fetch(`/api/clinic/schedules/${scheduleId}/cancel`, {
      method: "POST",
    });
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
      className="btn-ghost text-red-600 hover:bg-red-50 text-xs"
      onClick={onClick}
      disabled={busy || pending}
    >
      {busy || pending ? "Cancelling…" : "Cancel"}
    </button>
  );
}
