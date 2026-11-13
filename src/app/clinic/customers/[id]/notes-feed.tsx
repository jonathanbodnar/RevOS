"use client";

import { useEffect, useState } from "react";
import type { NoteView } from "@/lib/customer-notes";
import { useSetTabBadge } from "./customer-tabs";

/**
 * Notes tab: a composer on top of a dated feed, newest first. Writes go
 * straight into local state from the API response rather than through a
 * router.refresh(), which would re-render the whole profile (and re-log the
 * patient-record view) just to show one new note.
 */
export function NotesFeed({
  customerId,
  initialNotes,
  maxLength,
}: {
  customerId: string;
  initialNotes: NoteView[];
  maxLength: number;
}) {
  const [notes, setNotes] = useState(initialNotes);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Dates are shown in the viewer's timezone, which the server can't know —
  // render them only once mounted so SSR and hydration agree.
  const [mounted, setMounted] = useState(false);
  const setBadge = useSetTabBadge();

  useEffect(() => setMounted(true), []);
  // Re-sync if the server re-renders the profile (another tab's refresh).
  useEffect(() => setNotes(initialNotes), [initialNotes]);
  useEffect(() => setBadge("notes", notes.length), [notes.length, setBadge]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || saving) return;
    setSaving(true);
    setError(null);
    const res = await fetch(`/api/clinic/customers/${customerId}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    }).catch(() => null);
    const d = (res ? await res.json().catch(() => ({})) : {}) as {
      data?: NoteView;
      error?: string;
    };
    setSaving(false);
    if (!res?.ok || !d.data) {
      // Keep the draft so nothing typed is lost.
      setError(d.error || "Couldn't save the note. Please try again.");
      return;
    }
    const added = d.data;
    setNotes((prev) => [added, ...prev]);
    setDraft("");
  }

  async function remove(id: string) {
    if (!confirm("Remove this note? It will no longer appear in the feed.")) return;
    setRemovingId(id);
    setError(null);
    const res = await fetch(`/api/clinic/customers/${customerId}/notes/${id}`, {
      method: "DELETE",
    }).catch(() => null);
    const d = (res ? await res.json().catch(() => ({})) : {}) as { error?: string };
    setRemovingId(null);
    if (!res?.ok) {
      setError(d.error || "Couldn't remove the note. Please try again.");
      return;
    }
    setNotes((prev) => prev.filter((n) => n.id !== id));
  }

  return (
    <div className="space-y-6">
      <form onSubmit={add} className="card-pad">
        <label htmlFor="new-note" className="label">
          Add a note
        </label>
        <textarea
          id="new-note"
          className="input min-h-[5.5rem] resize-y"
          rows={3}
          maxLength={maxLength}
          placeholder="Write a note…"
          value={draft}
          disabled={saving}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        {error && (
          <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2 mt-3">
            {error}
          </div>
        )}
        <div className="mt-3 flex items-center justify-between gap-4">
          <p className="text-xs text-ink-subtle">
            Saved with today&apos;s date. Notes can&apos;t be edited once added.
          </p>
          <button
            type="submit"
            className="btn-primary"
            disabled={saving || !draft.trim()}
          >
            {saving ? "Adding…" : "Add note"}
          </button>
        </div>
      </form>

      {notes.length === 0 ? (
        <div className="card-pad text-center text-slate-500 py-12">
          <p className="text-sm">No notes yet.</p>
          <p className="text-xs text-slate-400 mt-1">
            Notes you add appear here, newest first, with the date they were
            written.
          </p>
        </div>
      ) : (
        <ol className="relative ml-2 border-l border-line">
          {notes.map((n) => (
            <li key={n.id} className="relative pl-6 pb-5 last:pb-0">
              <span
                aria-hidden
                className="absolute -left-[5.5px] top-[22px] h-2.5 w-2.5 rounded-full bg-brand-900 ring-4 ring-surface-base"
              />
              <article className="card px-5 py-4">
                <header className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-sm">
                      <time dateTime={n.createdAt} className="font-semibold text-ink">
                        {mounted ? noteDate(n.createdAt) : null}
                      </time>
                      {mounted && (
                        <span className="text-ink-subtle"> · {noteTime(n.createdAt)}</span>
                      )}
                    </div>
                    <div className="text-xs text-ink-subtle mt-0.5">{n.authorName}</div>
                  </div>
                  {n.canRemove && (
                    <button
                      type="button"
                      className="text-xs text-ink-subtle hover:text-red-600 disabled:opacity-40"
                      disabled={removingId === n.id}
                      onClick={() => remove(n.id)}
                    >
                      {removingId === n.id ? "Removing…" : "Remove"}
                    </button>
                  )}
                </header>
                {n.body === null ? (
                  <p className="mt-2 text-sm italic text-ink-subtle">
                    This note can&apos;t be decrypted with the server&apos;s current
                    encryption key.
                  </p>
                ) : (
                  <p className="mt-2 text-sm text-ink whitespace-pre-wrap break-words">
                    {n.body}
                  </p>
                )}
              </article>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function noteDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function noteTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}
