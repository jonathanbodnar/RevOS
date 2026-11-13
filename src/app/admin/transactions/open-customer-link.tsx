"use client";

import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useState, useTransition } from "react";
import { AssignClinic, type ClinicOption } from "../customers/assign-clinic";

/**
 * Opens a patient profile from the super-admin transactions list. Clinic pages
 * need clinic context, so this starts impersonation for the charge's clinic
 * first (same flow as the global patient search), then navigates. A row with
 * no clinic gets a clinic picker instead, since there is no context to open it
 * in yet. The picker defaults to the patient's own clinic when they have one
 * (a returning patient paying through a global link without `?c=`).
 */
export function OpenCustomerLink({
  customerId,
  clinicId,
  customerClinicId,
  name,
  clinics,
}: {
  customerId: string;
  clinicId: string | null;
  customerClinicId: string | null;
  name: string;
  clinics: ClinicOption[];
}) {
  const router = useRouter();
  const { update } = useSession();
  const [, startTransition] = useTransition();
  const [error, setError] = useState(false);

  async function open(targetClinicId: string) {
    setError(false);
    const res = await fetch("/api/admin/impersonate/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clinicId: targetClinicId }),
    });
    if (!res.ok) {
      setError(true);
      return;
    }
    await update({ impersonatingClinicId: targetClinicId });
    startTransition(() => {
      router.push(`/clinic/customers/${customerId}`);
      router.refresh();
    });
  }

  if (!clinicId) {
    return (
      <div className="space-y-1">
        <div>{name}</div>
        <AssignClinic
          customerId={customerId}
          clinics={clinics}
          defaultClinicId={customerClinicId}
          onAssigned={open}
        />
        {error && (
          <div className="text-xs text-red-600">Unable to open clinic context.</div>
        )}
      </div>
    );
  }

  return (
    <>
      <button
        onClick={() => open(clinicId)}
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
