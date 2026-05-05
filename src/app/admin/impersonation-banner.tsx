"use client";

import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useTransition } from "react";

export function ImpersonationBanner({
  impersonating,
}: {
  impersonating: boolean;
}) {
  const { update } = useSession();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (!impersonating) return null;

  async function stop() {
    await fetch("/api/admin/impersonate/stop", { method: "POST" });
    await update({ impersonatingClinicId: null });
    startTransition(() => {
      router.push("/admin");
      router.refresh();
    });
  }

  return (
    <div className="bg-amber-100 border-b border-amber-200 px-6 py-2 text-sm text-amber-900 flex items-center justify-between">
      <span>
        You are viewing RevOS as a clinic admin. All actions are audit-logged.
      </span>
      <button
        onClick={stop}
        disabled={pending}
        className="btn-secondary bg-white/80"
      >
        Exit clinic view
      </button>
    </div>
  );
}
