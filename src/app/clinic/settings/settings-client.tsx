"use client";

import { useRef, useState } from "react";

export function SettingsClient({
  clinic,
}: {
  clinic: { id: string; name: string; logoUrl: string | null };
}) {
  const [name, setName] = useState(clinic.name);
  const [logoUrl, setLogoUrl] = useState(clinic.logoUrl);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(
    null,
  );
  const fileRef = useRef<HTMLInputElement>(null);

  async function saveName() {
    setMsg(null);
    setSaving(true);
    const res = await fetch("/api/clinic/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    setSaving(false);
    if (res.ok) {
      setMsg({ type: "ok", text: "Clinic name updated." });
    } else {
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      setMsg({ type: "err", text: d.error || "Failed to update." });
    }
  }

  async function uploadLogo(file: File) {
    if (file.size > 2 * 1024 * 1024) {
      setMsg({ type: "err", text: "Logo must be under 2 MB." });
      return;
    }
    setMsg(null);
    setUploading(true);

    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = reader.result as string;
      const res = await fetch("/api/clinic/settings/logo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logo: base64 }),
      });
      setUploading(false);
      if (res.ok) {
        const d = (await res.json()) as { logoUrl?: string };
        setLogoUrl(d.logoUrl ?? base64);
        setMsg({ type: "ok", text: "Logo uploaded." });
      } else {
        setMsg({ type: "err", text: "Failed to upload logo." });
      }
    };
    reader.onerror = () => {
      setUploading(false);
      setMsg({ type: "err", text: "Failed to read file." });
    };
    reader.readAsDataURL(file);
  }

  async function removeLogo() {
    setMsg(null);
    const res = await fetch("/api/clinic/settings/logo", { method: "DELETE" });
    if (res.ok) {
      setLogoUrl(null);
      setMsg({ type: "ok", text: "Logo removed." });
    } else {
      setMsg({ type: "err", text: "Failed to remove logo." });
    }
  }

  return (
    <div className="max-w-xl space-y-8">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Settings</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Manage your clinic profile and branding.
        </p>
      </div>

      {msg && (
        <div
          className={`text-sm rounded-lg p-3 ${msg.type === "ok" ? "bg-emerald-50 text-emerald-700 border border-emerald-100" : "bg-red-50 text-red-700 border border-red-100"}`}
        >
          {msg.text}
        </div>
      )}

      {/* Clinic name */}
      <div className="card-pad space-y-3">
        <label className="label">Clinic name</label>
        <div className="flex items-center gap-3">
          <input
            className="input flex-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            className="btn-primary whitespace-nowrap"
            onClick={saveName}
            disabled={saving || !name.trim() || name === clinic.name}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {/* Logo */}
      <div className="card-pad space-y-4">
        <div>
          <label className="label">Clinic logo</label>
          <p className="text-xs text-slate-500 mt-0.5">
            Shown on payment pages and hosted payment links. PNG or SVG
            recommended, max 2 MB.
          </p>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex h-16 w-16 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 overflow-hidden shrink-0">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={logoUrl}
                alt="Clinic logo"
                className="h-full w-full object-contain"
              />
            ) : (
              <span className="text-xl font-bold text-slate-300">
                {clinic.name.charAt(0).toUpperCase()}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadLogo(f);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              className="btn-secondary text-xs"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? "Uploading…" : "Upload logo"}
            </button>
            {logoUrl && (
              <button
                type="button"
                className="text-xs text-slate-400 hover:text-red-600"
                onClick={removeLogo}
              >
                Remove logo
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
