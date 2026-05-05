"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function NewClinicForm() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    slug: "",
    contactEmail: "",
    adminName: "",
    adminEmail: "",
    adminPassword: "",
  });

  function update<K extends keyof typeof form>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/admin/clinics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error || "Failed to create clinic.");
      return;
    }
    startTransition(() => {
      router.push("/admin/clinics");
      router.refresh();
    });
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Clinic name</label>
          <input
            className="input"
            required
            value={form.name}
            onChange={(e) => update("name", e.target.value)}
          />
        </div>
        <div>
          <label className="label">Slug (optional)</label>
          <input
            className="input"
            placeholder="auto-generated"
            value={form.slug}
            onChange={(e) => update("slug", e.target.value)}
          />
        </div>
      </div>
      <div>
        <label className="label">Contact email (optional)</label>
        <input
          className="input"
          type="email"
          value={form.contactEmail}
          onChange={(e) => update("contactEmail", e.target.value)}
        />
      </div>

      <div className="border-t border-slate-100 pt-5">
        <h3 className="text-sm font-semibold text-slate-900 mb-3">
          Initial clinic admin
        </h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Admin name</label>
            <input
              className="input"
              required
              value={form.adminName}
              onChange={(e) => update("adminName", e.target.value)}
            />
          </div>
          <div>
            <label className="label">Admin email</label>
            <input
              className="input"
              type="email"
              required
              value={form.adminEmail}
              onChange={(e) => update("adminEmail", e.target.value)}
            />
          </div>
        </div>
        <div className="mt-4">
          <label className="label">Temporary password</label>
          <input
            className="input"
            type="text"
            required
            minLength={8}
            value={form.adminPassword}
            onChange={(e) => update("adminPassword", e.target.value)}
            placeholder="At least 8 characters"
          />
          <p className="text-xs text-slate-500 mt-1">
            Share with the admin securely. They can change it after first login.
          </p>
        </div>
      </div>

      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
          {error}
        </div>
      )}

      <div className="flex justify-end gap-3">
        <button
          type="button"
          className="btn-ghost"
          onClick={() => router.back()}
        >
          Cancel
        </button>
        <button type="submit" className="btn-primary" disabled={pending}>
          {pending ? "Creating…" : "Create clinic"}
        </button>
      </div>
    </form>
  );
}
