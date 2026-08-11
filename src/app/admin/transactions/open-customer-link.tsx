"use client";

import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useState, useTransition } from "react";

/**
 * Opens a patient profile from the super-admin transactions list. Clinic pages
 * need clinic context, so this starts impersonation for the charge's clinic
 * first (same flow as the global patient search), then navigates.
 */
export function OpenCustomerLink({
  customerId,
  clinicId,
  name,
}: {
  customerId: string;
  clinicId: string | null;
  name: string;
}) {
  const router = useRouter();
  const { update } = useSession();
  const [, startTransition] = useTransition();
  const [error, setError] = useState(false);

  if (!clinicId) return <span>{name}</span>;

  async function open() {
    setError(false);
    const res = await fetch("/api/admin/impersonate/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clinicId }),
    });
    if (!res.ok) {
      setError(true);
      return;
    }
    await update({ impersonatingClinicId: clinicId });
    startTransition(() => {
      router.push(`/clinic/customers/${customerId}`);
      router.refresh();
    });
  }

  return (
    <>
      <button
        onClick={open}
        className="text-brand-600 hover:underline text-left"
      >
        {name}
      </button>
      {error && (
        <div className="text-xs text-red-600">Unable to open clinic context.</div>
      )}
    </>
  );
}
