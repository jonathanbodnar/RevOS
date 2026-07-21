"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function CompleteButton({
  moduleId,
  initialDone,
}: {
  moduleId: string;
  initialDone: boolean;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [done, setDone] = useState(initialDone);
  const [busy, setBusy] = useState(false);

  async function set(next: boolean) {
    setBusy(true);
    const res = await fetch("/api/learning/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        moduleId,
        status: next ? "completed" : "in_progress",
      }),
    });
    setBusy(false);
    if (res.ok) {
      setDone(next);
      startTransition(() => router.refresh());
    }
  }

  return done ? (
    <button
      className="btn-secondary text-sm whitespace-nowrap"
      disabled={busy}
      onClick={() => set(false)}
    >
      ✓ Completed
    </button>
  ) : (
    <button
      className="btn-primary text-sm whitespace-nowrap"
      disabled={busy}
      onClick={() => set(true)}
    >
      {busy ? "Saving…" : "Mark complete"}
    </button>
  );
}
