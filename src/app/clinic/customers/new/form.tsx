"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function NewCustomerForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    address: "",
    city: "",
    state: "",
    zip: "",
  });

  function update<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/clinic/customers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error || "Failed to create customer.");
      return;
    }
    const data = (await res.json()) as { data: { id: string } };
    startTransition(() => {
      router.push(`/clinic/customers/${data.data.id}`);
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">First name</label>
          <input
            className="input"
            value={form.firstName}
            onChange={(e) => update("firstName", e.target.value)}
          />
        </div>
        <div>
          <label className="label">Last name</label>
          <input
            className="input"
            value={form.lastName}
            onChange={(e) => update("lastName", e.target.value)}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Email</label>
          <input
            className="input"
            type="email"
            value={form.email}
            onChange={(e) => update("email", e.target.value)}
          />
        </div>
        <div>
          <label className="label">Phone</label>
          <input
            className="input"
            value={form.phone}
            onChange={(e) => update("phone", e.target.value)}
          />
        </div>
      </div>
      <div>
        <label className="label">Street address</label>
        <input
          className="input"
          value={form.address}
          onChange={(e) => update("address", e.target.value)}
        />
      </div>
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="label">City</label>
          <input
            className="input"
            value={form.city}
            onChange={(e) => update("city", e.target.value)}
          />
        </div>
        <div>
          <label className="label">State</label>
          <input
            className="input"
            value={form.state}
            onChange={(e) => update("state", e.target.value)}
          />
        </div>
        <div>
          <label className="label">ZIP</label>
          <input
            className="input"
            value={form.zip}
            onChange={(e) => update("zip", e.target.value)}
          />
        </div>
      </div>

      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-3">
        <button type="button" className="btn-ghost" onClick={() => router.back()}>
          Cancel
        </button>
        <button className="btn-primary" disabled={pending}>
          {pending ? "Creating…" : "Create customer"}
        </button>
      </div>
    </form>
  );
}
