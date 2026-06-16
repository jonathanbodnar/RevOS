"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function EditCustomerButton({
  customerId,
  initial,
}: {
  customerId: string;
  initial: {
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
  };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [firstName, setFirstName] = useState(initial.firstName ?? "");
  const [lastName, setLastName] = useState(initial.lastName ?? "");
  const [email, setEmail] = useState(initial.email ?? "");
  const [phone, setPhone] = useState(initial.phone ?? "");

  function reset() {
    setFirstName(initial.firstName ?? "");
    setLastName(initial.lastName ?? "");
    setEmail(initial.email ?? "");
    setPhone(initial.phone ?? "");
    setError(null);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const res = await fetch(`/api/clinic/customers/${customerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        firstName: firstName.trim() || null,
        lastName: lastName.trim() || null,
        email: email.trim() || null,
        phone: phone.trim() || null,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Failed to save.");
      return;
    }
    setOpen(false);
    startTransition(() => router.refresh());
  }

  return (
    <>
      <button
        className="btn-secondary text-xs"
        onClick={() => {
          reset();
          setOpen(true);
        }}
        disabled={pending}
      >
        Edit details
      </button>

      {open && (
        <div
          className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) setOpen(false);
          }}
        >
          <div className="card-pad max-w-md w-full text-left">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-semibold text-slate-900">
                Edit patient details
              </h2>
              <button
                className="btn-ghost p-1 text-slate-400 hover:text-slate-600"
                onClick={() => !busy && setOpen(false)}
                aria-label="Close"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <form onSubmit={submit} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">First name</label>
                  <input
                    className="input"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                  />
                </div>
                <div>
                  <label className="label">Last name</label>
                  <input
                    className="input"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                  />
                </div>
              </div>
              <div>
                <label className="label">Email</label>
                <input
                  type="email"
                  className="input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div>
                <label className="label">Phone</label>
                <input
                  className="input"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>

              {error && (
                <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
                  {error}
                </div>
              )}

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn-secondary flex-1"
                  onClick={() => !busy && setOpen(false)}
                  disabled={busy}
                >
                  Cancel
                </button>
                <button type="submit" className="btn-primary flex-1" disabled={busy}>
                  {busy ? "Saving…" : "Save changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
