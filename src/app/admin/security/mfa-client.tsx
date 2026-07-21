"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

export function MfaClient({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [secret, setSecret] = useState<string | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setError(null);
    setBusy(true);
    const res = await fetch("/api/admin/mfa", { method: "POST" });
    setBusy(false);
    const d = (await res.json().catch(() => ({}))) as {
      data?: { secret: string; otpauthUri: string };
      error?: string;
    };
    if (!res.ok || !d.data) {
      setError(d.error || "Could not start enrollment.");
      return;
    }
    setSecret(d.data.secret);
    setUri(d.data.otpauthUri);
  }

  async function enable() {
    setError(null);
    setBusy(true);
    const res = await fetch("/api/admin/mfa", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Verification failed.");
      return;
    }
    setSecret(null);
    setUri(null);
    setCode("");
    startTransition(() => router.refresh());
  }

  async function disable() {
    setError(null);
    setBusy(true);
    const res = await fetch("/api/admin/mfa", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Could not disable MFA.");
      return;
    }
    setCode("");
    startTransition(() => router.refresh());
  }

  if (enabled) {
    return (
      <div className="card-pad space-y-3">
        <div className="flex items-center gap-2">
          <span className="badge-green">Enabled</span>
          <span className="text-sm text-slate-600">
            Two-factor authentication is on for your account.
          </span>
        </div>
        <p className="text-xs text-slate-500">
          To turn it off, enter a current code from your authenticator app.
        </p>
        <div className="flex gap-2">
          <input
            className="input w-40"
            inputMode="numeric"
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button className="btn-secondary" disabled={busy} onClick={disable}>
            Disable MFA
          </button>
        </div>
        {error && <div className="text-sm text-red-600">{error}</div>}
      </div>
    );
  }

  return (
    <div className="card-pad space-y-4">
      <div className="flex items-center gap-2">
        <span className="badge-slate">Not enabled</span>
        <span className="text-sm text-slate-600">
          Add an authenticator app (1Password, Google Authenticator, Authy…).
        </span>
      </div>

      {!secret ? (
        <button className="btn-primary" disabled={busy} onClick={start}>
          {busy ? "Starting…" : "Set up two-factor auth"}
        </button>
      ) : (
        <div className="space-y-3">
          <div>
            <div className="label">1. Add this key to your authenticator app</div>
            <code className="block bg-slate-100 rounded-md px-3 py-2 text-sm break-all">
              {secret}
            </code>
            <p className="text-xs text-slate-500 mt-1">
              Or open this setup link on the device with your authenticator:{" "}
              <a className="text-brand-600 break-all" href={uri ?? "#"}>
                {uri}
              </a>
            </p>
          </div>
          <div>
            <div className="label">2. Enter the 6-digit code it shows</div>
            <div className="flex gap-2">
              <input
                className="input w-40"
                inputMode="numeric"
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <button className="btn-primary" disabled={busy} onClick={enable}>
                {busy ? "Verifying…" : "Verify & enable"}
              </button>
            </div>
          </div>
        </div>
      )}
      {error && <div className="text-sm text-red-600">{error}</div>}
    </div>
  );
}
