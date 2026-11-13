"use client";

/**
 * The clinic's connect link on the staff Import page: create it, copy it,
 * revoke it. One live link per clinic; a new one replaces the old.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { CopyButton } from "@/components/copy-button";
import type { ConnectLinkView } from "@/lib/call-center/connect-link";
import { formatDate } from "@/lib/format";

const DAY_CHOICES = [7, 30, 90];

export function ConnectLinkCard({ clinicId, links }: { clinicId: string; links: ConnectLinkView[] }) {
  const router = useRouter();
  const [days, setDays] = useState(30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ id: string; url: string; expiresAt: string | null } | null>(null);
  const live = links.find((l) => l.state === "active") ?? null;
  const url = fresh?.url ?? live?.url ?? null;
  const expiresAt = fresh?.expiresAt ?? live?.expiresAt ?? null;
  const liveId = fresh?.id ?? live?.id ?? null;
  const past = links.filter((l) => l.state !== "active" && l.id !== fresh?.id);

  async function create() {
    if (liveId && !confirm("Make a new link? The current link stops working.")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/call-center/${clinicId}/connect-links`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ days }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        error?: string;
        link?: { id: string; url: string; expiresAt: string | null };
      };
      if (!res.ok || !json.link) setError(json.error || "Couldn't make the link.");
      else setFresh(json.link);
    } catch {
      setError("Lost the connection. Try again.");
    }
    setBusy(false);
    router.refresh();
  }

  async function revoke() {
    if (!liveId || !confirm("Turn this link off? Anyone using it will see that it expired.")) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/call-center/${clinicId}/connect-links/${liveId}`, { method: "DELETE" });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setError(json.error || "Couldn't turn the link off.");
      } else setFresh(null);
    } catch {
      setError("Lost the connection. Try again.");
    }
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="card-pad space-y-4">
      <p className="text-sm text-ink-muted">
        Send this to the clinic. On one page, with no login, they can connect their CRM or upload a spreadsheet of
        leads. They only ever see counts, never your leads.
      </p>
      {url ? (
        <div className="space-y-2">
          <div className="flex gap-2">
            <input className="input font-mono text-xs" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
            <CopyButton value={url} />
          </div>
          <p className="text-xs text-ink-subtle">
            {expiresAt ? `Works until ${formatDate(expiresAt)}.` : "Works until turned off."}
            {live?.lastUsedAt && !fresh ? ` Last opened ${formatDate(live.lastUsedAt)}.` : ""}
          </p>
        </div>
      ) : liveId ? (
        <p className="text-sm text-red-600">
          This link can&apos;t be shown again (the encryption key changed). Make a new one.
        </p>
      ) : (
        <p className="text-sm text-ink">No live link.</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="input w-auto py-2"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          aria-label="Link lasts"
        >
          {DAY_CHOICES.map((d) => (
            <option key={d} value={d}>
              Lasts {d} days
            </option>
          ))}
        </select>
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void create()}>
          {liveId ? "Make a new link" : "Make a link"}
        </button>
        {liveId && (
          <button type="button" className="btn-ghost text-red-600" disabled={busy} onClick={() => void revoke()}>
            Turn off
          </button>
        )}
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      {past.length > 0 && (
        <p className="text-xs text-ink-subtle">
          {past.length} older {past.length === 1 ? "link" : "links"} no longer work.
        </p>
      )}
    </div>
  );
}
