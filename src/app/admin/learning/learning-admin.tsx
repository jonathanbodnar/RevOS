"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

type Module = {
  id: string;
  title: string;
  summary: string | null;
  bodyMarkdown: string;
  videoUrl: string | null;
  category: string | null;
  audience: string;
  published: boolean;
  completions: number;
};

const AUDIENCES = [
  { value: "BOTH", label: "Everyone" },
  { value: "CLINIC_ADMIN", label: "Clinic admins" },
  { value: "PROVIDER", label: "Providers" },
];

const EMPTY = {
  title: "",
  summary: "",
  bodyMarkdown: "",
  videoUrl: "",
  category: "",
  audience: "BOTH",
};

export function LearningAdmin({ modules }: { modules: Module[] }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startNew() {
    setEditing("new");
    setForm({ ...EMPTY });
    setError(null);
  }
  function startEdit(m: Module) {
    setEditing(m.id);
    setForm({
      title: m.title,
      summary: m.summary ?? "",
      bodyMarkdown: m.bodyMarkdown,
      videoUrl: m.videoUrl ?? "",
      category: m.category ?? "",
      audience: m.audience,
    });
    setError(null);
  }

  async function save(publish: boolean) {
    setError(null);
    setBusy(true);
    const isNew = editing === "new";
    const res = await fetch(
      isNew ? "/api/admin/learning-modules" : `/api/admin/learning-modules/${editing}`,
      {
        method: isNew ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isNew ? { ...form, publish } : { ...form, published: publish }),
      },
    );
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Could not save.");
      return;
    }
    setEditing(null);
    startTransition(() => router.refresh());
  }

  async function setPublished(m: Module, published: boolean) {
    const res = await fetch(`/api/admin/learning-modules/${m.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ published }),
    });
    if (res.ok) startTransition(() => router.refresh());
  }
  async function remove(m: Module) {
    const res = await fetch(`/api/admin/learning-modules/${m.id}`, { method: "DELETE" });
    if (res.ok) startTransition(() => router.refresh());
  }

  return (
    <div className="space-y-4">
      {editing ? (
        <div className="card-pad space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-900">
              {editing === "new" ? "New module" : "Edit module"}
            </h3>
            <button className="btn-ghost text-xs" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="label">Title</label>
              <input
                className="input"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </div>
            <div>
              <label className="label">Category</label>
              <input
                className="input"
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                placeholder="e.g. Onboarding"
              />
            </div>
          </div>
          <div>
            <label className="label">Summary</label>
            <input
              className="input"
              value={form.summary}
              onChange={(e) => setForm({ ...form, summary: e.target.value })}
            />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="label">Video URL (optional, https)</label>
              <input
                className="input"
                value={form.videoUrl}
                onChange={(e) => setForm({ ...form, videoUrl: e.target.value })}
              />
            </div>
            <div>
              <label className="label">Audience</label>
              <select
                className="input"
                value={form.audience}
                onChange={(e) => setForm({ ...form, audience: e.target.value })}
              >
                {AUDIENCES.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="label">Content (Markdown)</label>
            <textarea
              className="input min-h-[220px] font-mono text-sm"
              value={form.bodyMarkdown}
              onChange={(e) => setForm({ ...form, bodyMarkdown: e.target.value })}
              placeholder="## Heading&#10;&#10;**Bold**, *italic*, [links](https://…), and&#10;- bullet lists"
            />
          </div>
          {error && (
            <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
              {error}
            </div>
          )}
          <div className="flex gap-2">
            <button className="btn-secondary" disabled={busy} onClick={() => save(false)}>
              Save draft
            </button>
            <button className="btn-primary" disabled={busy} onClick={() => save(true)}>
              {busy ? "Saving…" : "Save & publish"}
            </button>
          </div>
        </div>
      ) : (
        <button className="btn-primary" onClick={startNew}>
          + New module
        </button>
      )}

      <div className="card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Audience</th>
              <th>Status</th>
              <th>Completions</th>
              <th className="text-right pr-4">·</th>
            </tr>
          </thead>
          <tbody>
            {modules.length === 0 && (
              <tr>
                <td colSpan={5} className="text-center text-slate-500 py-10">
                  No modules yet.
                </td>
              </tr>
            )}
            {modules.map((m) => (
              <tr key={m.id}>
                <td className="font-medium text-slate-900">
                  {m.title}
                  {m.category && (
                    <span className="text-xs text-slate-400 ml-2">{m.category}</span>
                  )}
                </td>
                <td>
                  <span className="badge-slate">
                    {AUDIENCES.find((a) => a.value === m.audience)?.label ?? m.audience}
                  </span>
                </td>
                <td>
                  <span className={m.published ? "badge-green" : "badge-yellow"}>
                    {m.published ? "published" : "draft"}
                  </span>
                </td>
                <td className="text-slate-600">{m.completions}</td>
                <td className="text-right pr-4 whitespace-nowrap">
                  <button
                    className="text-xs text-slate-500 hover:underline"
                    onClick={() => startEdit(m)}
                  >
                    Edit
                  </button>
                  <button
                    className="text-xs text-slate-500 hover:underline ml-3"
                    onClick={() => setPublished(m, !m.published)}
                  >
                    {m.published ? "Unpublish" : "Publish"}
                  </button>
                  <button
                    className="text-xs text-red-500 hover:underline ml-3"
                    onClick={() => remove(m)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
