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
    <div className="bg-amber-50 border-b border-amber-200 px-10 py-2.5 text-sm text-amber-900 flex items-center justify-between gap-4">
      <div className="flex items-center gap-2">
        <span className="inline-flex h-1.5 w-1.5 rounded-full bg-amber-500" />
        <span>
          Viewing as clinic admin — all actions are audit-logged.
        </span>
      </div>
      <button
        onClick={stop}
        disabled={pending}
        className="text-xs font-medium text-amber-900 hover:underline disabled:opacity-50"
      >
        Exit clinic view →
      </button>
    </div>
  );
}
