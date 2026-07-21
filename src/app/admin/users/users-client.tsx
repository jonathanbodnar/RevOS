"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type UserRow = {
  id: string;
  name: string | null;
  email: string;
  role: string;
  roleLabel: string;
  isActive: boolean;
  clinicName: string | null;
  assignmentCount: number;
};

const ROLES = [
  { value: "CLINIC_ADMIN", label: "Clinic admin" },
  { value: "PROVIDER", label: "Provider" },
  { value: "BILLING_DEPT", label: "Billing dept" },
];

export function UsersClient({
  users,
  clinics,
}: {
  users: UserRow[];
  clinics: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [form, setForm] = useState({
    name: "",
    email: "",
    password: "",
    role: "CLINIC_ADMIN",
    clinicId: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsClinic = form.role === "CLINIC_ADMIN" || form.role === "PROVIDER";

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...form,
        clinicId: needsClinic ? form.clinicId : null,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Could not create user.");
      return;
    }
    setForm({ name: "", email: "", password: "", role: "CLINIC_ADMIN", clinicId: "" });
    startTransition(() => router.refresh());
  }

  async function toggleActive(u: UserRow) {
    const res = await fetch(`/api/admin/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !u.isActive }),
    });
    if (res.ok) startTransition(() => router.refresh());
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <form onSubmit={create} className="card-pad space-y-3 h-fit">
        <h3 className="text-sm font-semibold text-slate-900">Add a user</h3>
        <div>
          <label className="label">Name</label>
          <input
            className="input"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
        </div>
        <div>
          <label className="label">Email</label>
          <input
            type="email"
            className="input"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            required
          />
        </div>
        <div>
          <label className="label">Temporary password</label>
          <input
            type="text"
            className="input"
            value={form.password}
            minLength={8}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
          />
          <p className="text-xs text-slate-400 mt-1">Min 8 characters.</p>
        </div>
        <div>
          <label className="label">Role</label>
          <select
            className="input"
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value })}
          >
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        {needsClinic && (
          <div>
            <label className="label">Clinic</label>
            <select
              className="input"
              value={form.clinicId}
              onChange={(e) => setForm({ ...form, clinicId: e.target.value })}
              required
            >
              <option value="">Select a clinic…</option>
              {clinics.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
            {error}
          </div>
        )}
        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy ? "Creating…" : "Create user"}
        </button>
      </form>

      <div className="lg:col-span-2 card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Role</th>
                <th>Clinic</th>
                <th>Status</th>
                <th className="text-right pr-4">·</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={u.isActive ? undefined : "opacity-60"}>
                  <td className="font-medium text-slate-900">{u.name || "—"}</td>
                  <td className="text-slate-600">{u.email}</td>
                  <td>
                    <span className="badge-slate">{u.roleLabel}</span>
                    {u.role === "PROVIDER" && (
                      <span className="text-xs text-slate-400 ml-1">
                        {u.assignmentCount} patient
                        {u.assignmentCount === 1 ? "" : "s"}
                      </span>
                    )}
                  </td>
                  <td className="text-slate-600">{u.clinicName || "—"}</td>
                  <td>
                    <span className={u.isActive ? "badge-green" : "badge-slate"}>
                      {u.isActive ? "active" : "inactive"}
                    </span>
                  </td>
                  <td className="text-right pr-4">
                    {u.role !== "SUPER_ADMIN" && (
                      <button
                        className="text-xs text-slate-500 hover:text-slate-800 hover:underline"
                        onClick={() => toggleActive(u)}
                      >
                        {u.isActive ? "Deactivate" : "Reactivate"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
