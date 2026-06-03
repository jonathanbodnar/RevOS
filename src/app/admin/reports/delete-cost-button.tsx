"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

export function DeleteCostButton({ id }: { id: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  async function remove() {
    if (!confirm("Delete this advanced cost?")) return;
    await fetch(`/api/admin/advanced-costs/${id}`, { method: "DELETE" });
    startTransition(() => router.refresh());
  }

  return (
    <button
      className="text-xs text-red-600 hover:underline print-hidden"
      disabled={pending}
      onClick={remove}
    >
      Delete
    </button>
  );
}
