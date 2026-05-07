"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Member = {
  id: string;
  name: string | null;
  email: string;
  isActive: boolean;
  createdAt: string;
};

export function TeamClient({
  members,
  currentUserId,
}: {
  members: Member[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  // Add member form state
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [formLoading, setFormLoading] = useState(false);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setFormLoading(true);
    const res = await fetch("/api/clinic/team", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password }),
    });
    setFormLoading(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setFormError(d.error || "Failed to add team member.");
      return;
    }
    setAdding(false);
    setName("");
    setEmail("");
    setPassword("");
    router.refresh();
  }

  async function handleRemove(id: string, memberEmail: string) {
    if (!confirm(`Remove ${memberEmail} from this clinic? They will no longer be able to log in.`)) {
      return;
    }
    setRemovingId(id);
    const res = await fetch(`/api/clinic/team/${id}`, { method: "DELETE" });
    setRemovingId(null);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      alert(d.error || "Failed to remove team member.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-semibold text-slate-900">Team</h2>
          <p className="text-sm text-slate-500 mt-0.5">
            Team members have the same access as you and can manage customers,
            transactions, subscriptions, and payment links.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setAdding(true)}>
          + Add member
        </button>
      </div>

      {adding && (
        <div className="card-pad max-w-md">
          <h3 className="text-sm font-semibold text-slate-900 mb-4">
            Add team member
          </h3>
          <form onSubmit={handleAdd} className="space-y-3">
            <div>
              <label className="label">Full name</label>
              <input
                className="input"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Smith"
              />
            </div>
            <div>
              <label className="label">Email</label>
              <input
                className="input"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jane@example.com"
              />
            </div>
            <div>
              <label className="label">Password</label>
              <input
                className="input"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Minimum 8 characters"
              />
            </div>
            {formError && (
              <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
                {formError}
              </div>
            )}
            <div className="flex gap-3 pt-1">
              <button
                type="button"
                className="btn-secondary flex-1"
                onClick={() => {
                  setAdding(false);
                  setFormError(null);
                }}
                disabled={formLoading}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="btn-primary flex-1"
                disabled={formLoading}
              >
                {formLoading ? "Adding…" : "Add member"}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Status</th>
              <th>Added</th>
              <th className="text-right pr-4">Actions</th>
            </tr>
          </thead>
          <tbody>
            {members.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center text-slate-500 py-10">
                  No team members yet.
                </td>
              </tr>
            )}
            {members.map((m) => (
              <tr key={m.id}>
                <td className="font-medium text-slate-900">
                  {m.name || "—"}
                  {m.id === currentUserId && (
                    <span className="ml-2 badge-indigo text-xs">You</span>
                  )}
                </td>
                <td className="text-slate-600">{m.email}</td>
                <td>
                  <span className={m.isActive ? "badge-green" : "badge-slate"}>
                    {m.isActive ? "Active" : "Inactive"}
                  </span>
                </td>
                <td className="text-slate-500 text-xs">{m.createdAt}</td>
                <td className="text-right pr-4">
                  {m.id !== currentUserId && m.isActive && (
                    <button
                      className="btn-ghost text-red-600 hover:bg-red-50 text-xs disabled:opacity-40"
                      disabled={removingId === m.id}
                      onClick={() => handleRemove(m.id, m.email)}
                    >
                      {removingId === m.id ? "Removing…" : "Remove"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
