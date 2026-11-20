"use client";

/**
 * CRM connection for the staff Import page and the clinic connect link. The
 * clinic first picks which CRM it uses (Zenoti, Mindbody, Aesthetic Record),
 * then gets that one card, with a "How to find …" button for step-by-step help.
 * Connecting can take steps (pick a center, approve RevOS in Mindbody); "Sync
 * now" pulls leads in batches until the CRM has no more. Credentials are typed
 * here and sent once; the server never sends them back.
 */
import { Fragment, useEffect, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import type { IntegrationView } from "@/lib/crm/integrations";
import type { ConnectStep, CrmProvider } from "@/lib/crm/types";
import { CRM_LOGOS, guideFor, pickerHint, type CrmGuide } from "@/lib/crm/guides";
import { formatDateTime } from "@/lib/call-center/time";

type Mode = "staff" | "link";

const n = (v: number) => v.toLocaleString("en-US");

const STATUS_BADGE: Record<IntegrationView["status"], { label: string; cls: string }> = {
  not_connected: { label: "Not connected", cls: "badge-slate" },
  disconnected: { label: "Disconnected", cls: "badge-slate" },
  pending: { label: "Waiting", cls: "badge-yellow" },
  connected: { label: "Connected", cls: "badge-green" },
  error: { label: "Needs attention", cls: "badge-red" },
};

export function CrmConnections({
  mode,
  base,
  integrations,
  tz,
}: {
  mode: Mode;
  /** …/integrations API base for this clinic or link. */
  base: string;
  integrations: IntegrationView[];
  /** The clinic's time zone, so the server and the browser print the same times. */
  tz: string;
}) {
  // A clinic uses one CRM: open the one already connected (or being
  // connected), otherwise ask which one they use.
  const inUse = integrations.find((i) => i.status === "connected" || i.status === "pending" || i.status === "error");
  const [picked, setPicked] = useState<CrmProvider | null>(inUse?.provider ?? null);
  const view = picked ? integrations.find((i) => i.provider === picked) : undefined;
  if (!view) return <CrmPicker mode={mode} integrations={integrations} onPick={setPicked} />;
  return (
    <div className="max-w-xl space-y-3">
      <button type="button" className="btn-link text-sm" onClick={() => setPicked(null)}>
        ← Pick a different CRM
      </button>
      <CrmCard key={view.provider} mode={mode} base={base} view={view} tz={tz} />
    </div>
  );
}

function CrmPicker({
  mode,
  integrations,
  onPick,
}: {
  mode: Mode;
  integrations: IntegrationView[];
  onPick: (p: CrmProvider) => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm font-medium text-ink">
        {mode === "link" ? "Which one does your clinic use?" : "Which CRM does this clinic use?"}
      </p>
      <div className="grid sm:grid-cols-3 gap-4">
        {integrations.map((i) => {
          const logo = CRM_LOGOS[i.provider];
          return (
            <button
              key={i.provider}
              type="button"
              onClick={() => onPick(i.provider)}
              className="card-pad text-left flex flex-col gap-4 transition hover:border-neutral-400 hover:shadow-sm"
            >
              <span className="h-10 flex items-center">
                <Image
                  src={logo.src}
                  alt={i.label}
                  width={logo.width}
                  height={logo.height}
                  unoptimized
                  className={`${logo.size} w-auto object-contain object-left`}
                />
              </span>
              <span className="text-sm text-ink-muted">{pickerHint(i.provider, !i.unavailable)}</span>
              {i.status === "connected" && <span className="badge-green self-start">Connected</span>}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-ink-subtle">Not one of these? Upload a spreadsheet instead.</p>
    </div>
  );
}

/** Numbered steps for finding a key or exporting a list, with menu paths and screenshots. */
function GuideDialog({ guide, onClose }: { guide: CrmGuide; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="crm-guide-title"
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:items-center"
      onClick={onClose}
    >
      <div className="card my-8 w-full max-w-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-line px-6 pb-4 pt-5">
          <div>
            <h2 id="crm-guide-title" className="text-lg font-semibold text-ink">
              {guide.title}
            </h2>
            <p className="mt-1 text-sm text-ink-muted">{guide.intro}</p>
          </div>
          <button type="button" className="btn-ghost !py-1.5" onClick={onClose}>
            Close
          </button>
        </div>
        <ol className="space-y-5 px-6 py-5">
          {guide.steps.map((s, i) => (
            <li key={i} className="flex gap-4">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-brand-900 text-sm font-semibold text-white">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1 space-y-2 pt-0.5">
                <p className="text-sm text-ink">{s.text}</p>
                {s.path && (
                  <p className="flex flex-wrap items-center gap-1.5 text-xs">
                    {s.path.map((p, j) => (
                      <Fragment key={p}>
                        {j > 0 && <span className="text-ink-subtle">›</span>}
                        <span className="rounded-md border border-line bg-surface-base px-2 py-0.5 font-medium text-ink">{p}</span>
                      </Fragment>
                    ))}
                  </p>
                )}
                {s.image && (
                  // Screenshots are plain files under /public/crm/guides.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.image.src} alt={s.image.alt} className="w-full rounded-lg border border-line" />
                )}
              </div>
            </li>
          ))}
        </ol>
        {(guide.note || guide.source) && (
          <div className="space-y-1.5 px-6 pb-2 text-xs text-ink-muted">
            {guide.note && <p>{guide.note}</p>}
            {guide.source && (
              <a href={guide.source.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
                {guide.source.label} ↗
              </a>
            )}
          </div>
        )}
        <div className="px-6 pb-6 pt-3">
          <button type="button" className="btn-primary" onClick={onClose}>
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

type SyncState = { running: boolean; pulled: number; added: number; updated: number; invalid: number; done: boolean };

function CrmCard({ mode, base, view: fromServer, tz }: { mode: Mode; base: string; view: IntegrationView; tz: string }) {
  const router = useRouter();
  // The newest view: from a connect response, until the page refresh catches up.
  const [latest, setLatest] = useState<IntegrationView | null>(null);
  const view =
    latest && (!fromServer.updatedAt || (latest.updatedAt ?? "") > fromServer.updatedAt) ? latest : fromServer;
  const [values, setValues] = useState<Record<string, string>>({});
  const [step, setStep] = useState<ConnectStep | null>(null);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [guideOpen, setGuideOpen] = useState(false);
  const status = view.status;
  const badge = STATUS_BADGE[status];
  const isAR = view.provider === "aesthetic_record";

  async function post(path: string, body: unknown): Promise<Record<string, unknown> | null> {
    setError(null);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        setError(typeof json.error === "string" ? json.error : "Something went wrong. Try again.");
        return null;
      }
      return json;
    } catch {
      setError("Lost the connection. Try again.");
      return null;
    }
  }

  async function connect(input: Record<string, string>) {
    setBusy(true);
    const json = await post(`${base}/${view.provider}`, { input });
    setBusy(false);
    if (!json) return;
    const next = (json.step as ConnectStep | null) ?? null;
    setStep(next);
    setValues({});
    setChoice("");
    const saved = json.view as IntegrationView | undefined;
    if (saved) setLatest(saved);
    router.refresh();
    // Pull the leads right away so connecting is all the clinic has to do.
    if (saved?.status === "connected") await syncNow();
  }

  async function syncNow() {
    let state: SyncState = { running: true, pulled: 0, added: 0, updated: 0, invalid: 0, done: false };
    setSync(state);
    let importId: string | undefined;
    let cursor: string | undefined;
    for (let i = 0; i < 400; i++) {
      const json = await post(`${base}/${view.provider}/sync`, { importId, cursor });
      if (!json) break;
      const counts = (json.counts ?? {}) as Record<string, number>;
      state = {
        running: !json.done,
        pulled: state.pulled + (counts.received ?? 0),
        added: state.added + (counts.created ?? 0),
        updated: state.updated + (counts.updated ?? 0),
        invalid: state.invalid + (counts.invalid ?? 0),
        done: !!json.done,
      };
      setSync(state);
      if (json.done) break;
      importId = typeof json.importId === "string" ? json.importId : undefined;
      cursor = typeof json.cursor === "string" ? json.cursor : undefined;
      if (!cursor) break;
    }
    setSync((s) => (s ? { ...s, running: false } : s));
    router.refresh();
  }

  async function disconnect() {
    if (!confirm(`Disconnect ${view.label}? Leads already imported stay.`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${base}/${view.provider}`, { method: "DELETE" });
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        setError(json.error || "Couldn't disconnect.");
      }
    } catch {
      setError("Lost the connection. Try again.");
    }
    setBusy(false);
    setStep(null);
    router.refresh();
  }

  const form = (
    <form
      className="space-y-3 mt-4"
      onSubmit={(e) => {
        e.preventDefault();
        void connect(values);
      }}
    >
      {view.connectFields.map((f) => (
        <div key={f.name}>
          <label className="label" htmlFor={`${view.provider}-${f.name}`}>
            {f.label}
          </label>
          <input
            id={`${view.provider}-${f.name}`}
            className="input"
            type={f.type}
            autoComplete="off"
            placeholder={f.placeholder}
            value={values[f.name] ?? ""}
            onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
            required
          />
          {f.help && <p className="help-text">{f.help}</p>}
        </div>
      ))}
      <button type="submit" className="btn-primary" disabled={busy}>
        {busy ? "Connecting…" : `Connect ${view.label}`}
      </button>
    </form>
  );

  let body: React.ReactNode;
  if (isAR) {
    body = (
      <div className="mt-3 space-y-3 text-sm text-ink-muted">
        <p>
          Aesthetic Record doesn&apos;t let other apps read your client list yet. Ask Aesthetic Record support for an
          API key for RevOS, and let us know you want this.
        </p>
        {status === "pending" ? (
          <p className="text-ink">
            Request noted{view.updatedAt ? ` on ${formatDateTime(view.updatedAt, tz)}` : ""}. We&apos;ll connect it as soon as
            Aesthetic Record allows it.
          </p>
        ) : (
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => void connect({})}>
            {busy ? "Saving…" : "I want this connected"}
          </button>
        )}
        <p>Until then, export your client list and upload it on this page.</p>
      </div>
    );
  } else if (view.unavailable) {
    body = <p className="mt-3 text-sm text-ink-muted">{view.unavailable}</p>;
  } else if (step?.kind === "choose") {
    body = (
      <form
        className="space-y-3 mt-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (choice) void connect({ [step.field]: choice });
        }}
      >
        <div>
          <label className="label" htmlFor={`${view.provider}-choice`}>
            {step.label}
          </label>
          <select
            id={`${view.provider}-choice`}
            className="input"
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            required
          >
            <option value="">Choose…</option>
            {step.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn-primary" disabled={busy || !choice}>
          {busy ? "Connecting…" : "Continue"}
        </button>
      </form>
    );
  } else if (step?.kind === "approve") {
    body = (
      <div className="mt-4 space-y-3 text-sm text-ink-muted">
        <p>The {view.label} account owner needs to approve RevOS:</p>
        {step.url && (
          <a href={step.url} target="_blank" rel="noopener noreferrer" className="btn-secondary">
            Open the approval page
          </a>
        )}
        {step.code && (
          <p>
            Or in {view.label}, go to Manager Tools, then Mindbody Add Ons, then API Integrations, and enter this code:{" "}
            <span className="font-mono text-ink">{step.code}</span>
          </p>
        )}
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void connect({ action: "check" })}>
          {busy ? "Checking…" : "I approved it"}
        </button>
      </div>
    );
  } else if (status === "pending") {
    body = (
      <div className="mt-4">
        <p className="text-sm text-ink-muted">Connecting isn&apos;t finished.</p>
        <div className="flex gap-2 mt-3">
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void connect({ action: "resume" })}>
            {busy ? "Loading…" : "Finish connecting"}
          </button>
          {mode === "staff" && (
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => void disconnect()}>
              Cancel
            </button>
          )}
        </div>
      </div>
    );
  } else if (status === "connected") {
    body = (
      <div className="mt-3 space-y-3">
        <p className="text-sm text-ink">
          {view.accountLabel || view.label}
          <span className="block text-xs text-ink-subtle">
            {view.lastSyncAt ? `Last synced ${formatDateTime(view.lastSyncAt, tz)}` : "Not synced yet"}
          </span>
        </p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary" disabled={busy || !!sync?.running} onClick={() => void syncNow()}>
            {sync?.running ? "Syncing…" : "Sync now"}
          </button>
          {mode === "staff" && (
            <button type="button" className="btn-ghost" disabled={busy || !!sync?.running} onClick={() => void disconnect()}>
              Disconnect
            </button>
          )}
        </div>
      </div>
    );
  } else {
    body = (
      <>
        {status === "error" && view.lastError && <p className="mt-3 text-sm text-red-600">{view.lastError}</p>}
        {form}
      </>
    );
  }

  const guide = guideFor(view.provider, !view.unavailable);
  const comingSoon = !!view.unavailable && !isAR;
  return (
    <div className="card-pad flex flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h3 className="section-title">{view.label}</h3>
        <button type="button" className="btn-secondary !px-3 !py-1 text-xs" onClick={() => setGuideOpen(true)}>
          {guide.button}
        </button>
        <span className={comingSoon ? "badge-slate" : badge.cls}>
          {comingSoon ? "Coming soon" : isAR && status === "pending" ? "Requested" : badge.label}
        </span>
      </div>
      {body}
      {sync && (
        <p className="mt-3 text-xs text-ink-muted">
          {sync.running ? "Pulling leads… " : sync.done ? "Done. " : "Stopped. "}
          {n(sync.pulled)} from {view.label}
          {mode === "staff" && ` · ${n(sync.added)} added · ${n(sync.updated)} updated`}
          {sync.invalid > 0 && ` · ${n(sync.invalid)} with no usable phone`}
        </p>
      )}
      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      {status === "connected" && view.lastError && !error && (
        <p className="mt-3 text-xs text-red-600">Last sync: {view.lastError}</p>
      )}
      {guideOpen && <GuideDialog guide={guide} onClose={() => setGuideOpen(false)} />}
    </div>
  );
}
