"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatPhone } from "@/lib/phone";

type Setup = {
  configured: boolean;
  apiKey: boolean;
  webhookKey: boolean;
  callControlAppId: string | null;
  credentialConnectionId: string | null;
  webhookUrl: string | null;
};
type Clinic = {
  id: string;
  name: string;
  state: string | null;
  city: string | null;
  areaCode: string | null;
  numbers: { id: string; e164: string; isDefault: boolean }[];
};
type Found = { phoneNumber: string; region: string; monthly: string | null; upfront: string | null };

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json" } });
  const body = (await res.json().catch(() => ({}))) as { data?: T; error?: string };
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body.data as T;
}

function Step({ done, title, children }: { done: boolean; title: string; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className={`mt-0.5 h-5 w-5 shrink-0 rounded-full grid place-items-center text-[11px] font-semibold ${done ? "bg-emerald-600 text-white" : "bg-surface-alt text-ink-subtle border border-line"}`}>
        {done ? "✓" : ""}
      </span>
      <div className="text-sm">
        <div className="font-medium text-ink">{title}</div>
        {children && <div className="text-ink-muted mt-0.5">{children}</div>}
      </div>
    </li>
  );
}

export function PhoneSetupClient({ setup, clinics, appUrl }: { setup: Setup; clinics: Clinic[]; appUrl: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function runSetup() {
    setBusy(true);
    setMsg(null);
    try {
      await call("/api/call-center/admin/telnyx", { method: "POST" });
      setMsg({ ok: true, text: "Telnyx is set up. Now give each clinic a number." });
      router.refresh();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "Setup failed." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="card-pad space-y-4">
        <div>
          <div className="section-title">Connect Telnyx</div>
          <div className="section-subtitle">One time. Calls and numbers use RevOS&apos;s Telnyx account.</div>
        </div>
        <ol className="space-y-3">
          <Step done={setup.apiKey} title="Add the Telnyx API key">
            Set <code>TELNYX_API_KEY</code> on the server (Railway → RevOS → Variables). Use a separate key for Dev and production.
          </Step>
          <Step done={setup.webhookKey} title="Add the Telnyx public key">
            Set <code>TELNYX_PUBLIC_KEY</code> from Mission Control → Keys &amp; Credentials → Public Key. RevOS uses it to check that call events really come from Telnyx.
          </Step>
          <Step done={setup.configured} title="Create RevOS's phone connections">
            Creates a US-only calling profile, the dialer app and the agents&apos; browser-phone connection, all pointed at{" "}
            <code>{setup.webhookUrl ?? `${appUrl ?? "this site"}/api/webhooks/telnyx`}</code>.
            <div className="mt-2">
              <button className="btn-primary" disabled={!setup.apiKey || busy} onClick={runSetup}>
                {busy ? "Working…" : setup.configured ? "Run again (re-point webhooks)" : "Set up Telnyx"}
              </button>
            </div>
          </Step>
        </ol>
        {msg && <div className={`text-sm ${msg.ok ? "text-emerald-700" : "text-red-700"}`}>{msg.text}</div>}
      </div>

      <div className="space-y-4">
        <div>
          <div className="section-title">Clinic numbers</div>
          <div className="section-subtitle">
            Calls to a clinic&apos;s leads go out from its number, and patients who call it back ring the call center. Buying a number starts a monthly charge on the Telnyx account.
          </div>
        </div>
        {clinics.map((c) => (
          <ClinicNumbers key={c.id} clinic={c} enabled={setup.configured} />
        ))}
      </div>
    </div>
  );
}

function ClinicNumbers({ clinic, enabled }: { clinic: Clinic; enabled: boolean }) {
  const router = useRouter();
  const [areaCode, setAreaCode] = useState(clinic.areaCode ?? "");
  const [state, setState] = useState((clinic.state ?? "").slice(0, 2).toUpperCase());
  const [found, setFound] = useState<Found[] | null>(null);
  const [attach, setAttach] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function search() {
    setBusy(true);
    setErr(null);
    try {
      const sp = new URLSearchParams();
      if (areaCode) sp.set("areaCode", areaCode);
      else if (state) sp.set("state", state);
      setFound(await call<Found[]>(`/api/call-center/admin/numbers?${sp}`));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Search failed.");
    } finally {
      setBusy(false);
    }
  }
  async function add(phoneNumber: string, mode: "buy" | "attach", price?: string | null) {
    if (mode === "buy" && !window.confirm(`Buy ${formatPhone(phoneNumber)} for ${clinic.name}?${price ? ` About $${price}/month on the Telnyx account.` : ""}`)) return;
    setBusy(true);
    setErr(null);
    try {
      await call("/api/call-center/admin/numbers", { method: "POST", body: JSON.stringify({ clinicId: clinic.id, phoneNumber, mode }) });
      setFound(null);
      setAttach("");
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    if (!window.confirm("Take this number off the clinic? It stays in the Telnyx account (and keeps billing) until it's released there.")) return;
    await call(`/api/call-center/admin/numbers/${id}`, { method: "DELETE" }).catch((e) => setErr(e.message));
    router.refresh();
  }

  return (
    <div className="card-pad">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="font-semibold text-ink">{clinic.name}</div>
          <div className="text-xs text-ink-subtle">{[clinic.city, clinic.state].filter(Boolean).join(", ") || "No address on file"}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          {clinic.numbers.length === 0 && <span className="badge-yellow">No number yet</span>}
          {clinic.numbers.map((n) => (
            <span key={n.id} className="inline-flex items-center gap-2 rounded-full border border-line px-3 py-1 text-sm">
              {formatPhone(n.e164)}
              {n.isDefault && <span className="text-[10px] uppercase tracking-wider text-ink-subtle">calls from</span>}
              <button className="text-xs text-ink-subtle hover:text-red-700" onClick={() => remove(n.id)} aria-label={`Remove ${n.e164}`}>
                ✕
              </button>
            </span>
          ))}
        </div>
      </div>
      {enabled && (
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="label">Find a local number</label>
            <div className="flex gap-2">
              <input className="input !w-28" placeholder="Area code" value={areaCode} onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, "").slice(0, 3))} />
              <input className="input !w-20" placeholder="State" value={state} onChange={(e) => setState(e.target.value.toUpperCase().slice(0, 2))} />
              <button className="btn-secondary" disabled={busy || (!areaCode && !state)} onClick={search}>
                Search
              </button>
            </div>
          </div>
          <div>
            <label className="label">Or attach a number already in Telnyx</label>
            <div className="flex gap-2">
              <input className="input" placeholder="+1 555 010 0000" value={attach} onChange={(e) => setAttach(e.target.value)} />
              <button className="btn-secondary" disabled={busy || attach.replace(/\D/g, "").length < 10} onClick={() => add(attach.replace(/\D/g, "").slice(-10), "attach")}>
                Attach
              </button>
            </div>
          </div>
        </div>
      )}
      {err && <div className="mt-3 text-sm text-red-700">{err}</div>}
      {found && (
        <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-2">
          {found.length === 0 && <div className="text-sm text-ink-muted">No numbers found. Try the state instead of the area code.</div>}
          {found.map((f) => (
            <div key={f.phoneNumber} className="flex items-center justify-between rounded-lg border border-line px-3 py-2">
              <div>
                <div className="text-sm font-medium tabular-nums">{formatPhone(f.phoneNumber)}</div>
                <div className="text-xs text-ink-subtle">
                  {f.region}
                  {f.monthly ? ` · $${f.monthly}/mo` : ""}
                </div>
              </div>
              <button className="btn-primary !py-1 !px-3 text-xs" disabled={busy} onClick={() => add(f.phoneNumber, "buy", f.monthly)}>
                Buy
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
