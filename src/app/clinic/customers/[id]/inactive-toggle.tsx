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
        ? "Mark this patient active again? They will reappear in the default customer list.\n\nNote: this does NOT restart any billing that was cancelled — recreate it manually if needed."
        : "Mark this patient inactive? They will be hidden from the default customer list but kept for history and reporting.",
    );
    if (!ok) return;

    // Deactivating does not stop recurring billing on its own — LunarPay runs
    // the schedule. Ask explicitly, with a count, because cancelling there
    // cannot be undone.
    let cancelPendingPayments = false;
    if (!next) {
      setBusy(true);
      const p = await fetch(`/api/clinic/customers/${customerId}`).then((r) =>
        r.ok ? r.json() : null,
      );
      setBusy(false);
      const subs = p?.subscriptions ?? 0;
      const scheds = p?.schedules ?? 0;
      if (subs + scheds > 0) {
        const when = p?.nextPaymentOn
          ? ` The next one runs ${new Date(p.nextPaymentOn).toLocaleDateString()}.`
          : "";
        const parts = [
          subs ? `${subs} active subscription${subs === 1 ? "" : "s"}` : null,
          scheds ? `${scheds} payment schedule${scheds === 1 ? "" : "s"}` : null,
        ].filter(Boolean);
        cancelPendingPayments = confirm(
          `This patient still has ${parts.join(" and ")} that will keep charging their card.${when}\n\n` +
            `OK — cancel them now (this cannot be undone).\n` +
            `Cancel — mark inactive but KEEP billing them.`,
        );
      }
    }

    setBusy(true);
    const res = await fetch(`/api/clinic/customers/${customerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: next, cancelPendingPayments }),
    });
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      alert(d.error || "Failed to update status.");
      return;
    }
    const body = (await res.json().catch(() => ({}))) as {
      billingCancelled?: { subscriptionsCancelled: number; schedulesCancelled: number; errors: string[] };
    };
    const b = body.billingCancelled;
    if (b?.errors?.length) {
      alert(
        `Marked inactive, but ${b.errors.length} item(s) could NOT be cancelled and may still charge:\n\n` +
          b.errors.join("\n"),
      );
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
