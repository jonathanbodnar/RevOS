"use client";

import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useTransition } from "react";

export function ImpersonateButton({ clinicId }: { clinicId: string }) {
  const { update } = useSession();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  async function loginAsClinic() {
    const res = await fetch("/api/admin/impersonate/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clinicId }),
    });
    if (!res.ok) {
      alert("Unable to login as this clinic.");
      return;
    }
    await update({ impersonatingClinicId: clinicId });
    startTransition(() => {
      router.push("/clinic");
      router.refresh();
    });
  }

  return (
    <button
      onClick={loginAsClinic}
      disabled={pending}
      className="btn-secondary"
    >
      Login as clinic
    </button>
  );
}
