"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { formatMoneyCents } from "@/lib/format";

export function RefundButton({
  chargeId,
  maxCents,
}: {
  chargeId: string;
  maxCents: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);

  async function onClick() {
    const input = prompt(
      `Refund amount in USD (max ${formatMoneyCents(maxCents)}). Leave empty for full refund.`,
      "",
    );
    if (input === null) return;
    const amount = input.trim();
    setBusy(true);
    const res = await fetch(`/api/clinic/charges/${chargeId}/refund`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(amount ? { amount } : {}),
    });
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      alert(d.error || "Refund failed.");
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <button
      onClick={onClick}
      disabled={busy || pending}
      className="btn-ghost text-red-600 hover:bg-red-50"
    >
      Refund
    </button>
  );
}
