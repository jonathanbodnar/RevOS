"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * Self-service two-factor setup for the signed-in user, any role.
 *
 * Talks to /api/account/mfa, which always acts on the caller's own account.
 * The QR is the main event: scanning beats typing a 32-character key, which is
 * what the previous key-only screen forced people to do.
 */
export function MfaSetup({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [secret, setSecret] = useState<string | null>(null);
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const [uri, setUri] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setError(null);
    setBusy(true);
    const res = await fetch("/api/account/mfa", { method: "POST" });
    setBusy(false);
    const d = (await res.json().catch(() => ({}))) as {
      data?: { secret: string; otpauthUri: string; qrSvg: string };
      error?: string;
    };
    if (!res.ok || !d.data) {
      setError(d.error || "Could not start setup.");
      return;
    }
    setSecret(d.data.secret);
    setQrSvg(d.data.qrSvg);
    setUri(d.data.otpauthUri);
  }

  async function submit(method: "PUT" | "DELETE") {
    setError(null);
    setBusy(true);
    const res = await fetch("/api/account/mfa", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    setBusy(false);
    if (!res.ok) {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setError(d.error || "Something went wrong.");
      return;
    }
    setSecret(null);
    setQrSvg(null);
    setUri(null);
    setCode("");
    startTransition(() => router.refresh());
  }

  if (enabled) {
    return (
      <div className="card-pad space-y-3">
        <div className="flex items-center gap-2">
          <span className="badge-green">On</span>
          <span className="text-sm text-slate-600">
            Your account asks for a code from your authenticator app at sign-in.
          </span>
        </div>
        <p className="text-xs text-slate-500">
          To turn it off, enter a current code from your app.
        </p>
        <div className="flex gap-2">
          <input
            className="input w-40"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button
            className="btn-secondary"
            disabled={busy}
            onClick={() => submit("DELETE")}
          >
            {busy ? "Working…" : "Turn off"}
          </button>
        </div>
        {error && <div className="text-sm text-red-600">{error}</div>}
      </div>
    );
  }

  return (
    <div className="card-pad space-y-4">
      <div className="flex items-center gap-2">
        <span className="badge-slate">Off</span>
        <span className="text-sm text-slate-600">
          Add a second step at sign-in using any authenticator app — Authy,
          1Password, Google Authenticator.
        </span>
      </div>

      {!secret ? (
        <button className="btn-primary" disabled={busy} onClick={start}>
          {busy ? "Starting…" : "Set up two-factor auth"}
        </button>
      ) : (
        <div className="space-y-4">
          <div>
            <div className="label">1. Scan this with your authenticator app</div>
            {qrSvg && (
              <div
                className="mt-2 inline-block bg-white p-3 rounded-lg border border-line [&>svg]:h-44 [&>svg]:w-44"
                // The SVG is generated server-side by the qrcode package from
                // our own otpauth URI — no user-controlled markup reaches here.
                dangerouslySetInnerHTML={{ __html: qrSvg }}
              />
            )}
          </div>

          <div>
            <button
              type="button"
              className="text-xs text-brand-600 hover:underline"
              onClick={() => setShowKey((v) => !v)}
            >
              {showKey ? "Hide" : "Can't scan? Enter a key manually"}
            </button>
            {showKey && (
              <div className="mt-2 space-y-1">
                <code className="block bg-slate-100 rounded-md px-3 py-2 text-sm break-all">
                  {secret}
                </code>
                <p className="text-xs text-slate-500">
                  Choose &ldquo;time-based&rdquo; (TOTP), 6 digits, 30 seconds.{" "}
                  <a className="text-brand-600 break-all" href={uri ?? "#"}>
                    Or open this setup link on the device with your app
                  </a>
                  .
                </p>
              </div>
            )}
          </div>

          <div>
            <div className="label">2. Enter the 6-digit code it shows</div>
            <div className="flex gap-2">
              <input
                className="input w-40"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <button
                className="btn-primary"
                disabled={busy}
                onClick={() => submit("PUT")}
              >
                {busy ? "Verifying…" : "Verify & turn on"}
              </button>
            </div>
          </div>
        </div>
      )}
      {error && <div className="text-sm text-red-600">{error}</div>}
    </div>
  );
}
