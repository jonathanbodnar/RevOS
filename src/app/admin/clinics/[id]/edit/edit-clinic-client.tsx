"use client";

import { useRef, useState } from "react";
import Link from "next/link";

export function EditClinicClient({
  clinic,
}: {
  clinic: {
    id: string;
    name: string;
    slug: string;
    logoUrl: string | null;
    revosDownPaymentSharePct: number;
    implementorFeeCents: number;
    revosRecurringShareCents: number;
  };
}) {
  const [name, setName] = useState(clinic.name);
  const [logoUrl, setLogoUrl] = useState(clinic.logoUrl);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(
    null,
  );
  const fileRef = useRef<HTMLInputElement>(null);

  // Revenue-share config
  const [downPct, setDownPct] = useState(String(clinic.revosDownPaymentSharePct));
  const [implFee, setImplFee] = useState((clinic.implementorFeeCents / 100).toFixed(2));
  const [recurShare, setRecurShare] = useState((clinic.revosRecurringShareCents / 100).toFixed(2));
  const [savingShare, setSavingShare] = useState(false);

  async function saveShareConfig() {
    setMsg(null);
    const pct = parseInt(downPct, 10);
    const fee = Math.round(parseFloat(implFee) * 100);
    const recur = Math.round(parseFloat(recurShare) * 100);
    if (Number.isNaN(pct) || pct < 0 || pct > 100) {
      setMsg({ type: "err", text: "Down payment share must be 0–100%." });
      return;
    }
    if (Number.isNaN(fee) || fee < 0 || Number.isNaN(recur) || recur < 0) {
      setMsg({ type: "err", text: "Enter valid dollar amounts." });
      return;
    }
    setSavingShare(true);
    const res = await fetch(`/api/admin/clinics/${clinic.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        revosDownPaymentSharePct: pct,
        implementorFeeCents: fee,
        revosRecurringShareCents: recur,
      }),
    });
    setSavingShare(false);
    setMsg(
      res.ok
        ? { type: "ok", text: "Revenue-share settings saved." }
        : { type: "err", text: "Failed to save revenue-share settings." },
    );
  }

  async function saveName() {
    setMsg(null);
    setSaving(true);
    const res = await fetch(`/api/admin/clinics/${clinic.id}`, {
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
      const res = await fetch(`/api/admin/clinics/${clinic.id}/logo`, {
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
    const res = await fetch(`/api/admin/clinics/${clinic.id}/logo`, {
      method: "DELETE",
    });
    if (res.ok) {
      setLogoUrl(null);
      setMsg({ type: "ok", text: "Logo removed." });
    } else {
      setMsg({ type: "err", text: "Failed to remove logo." });
    }
  }

  return (
    <div className="space-y-6 max-w-xl">
      <div className="flex items-center gap-3">
        <Link
          href="/admin/clinics"
          className="text-sm text-slate-500 hover:text-slate-700"
        >
          ← Clinics
        </Link>
      </div>

      <div>
        <h2 className="text-xl font-semibold text-slate-900">
          Edit clinic
        </h2>
        <p className="text-sm text-slate-500 mt-0.5">
          {clinic.name} · <code className="text-xs">{clinic.slug}</code>
        </p>
      </div>

      {msg && (
        <div
          className={`text-sm rounded-lg p-3 ${
            msg.type === "ok"
              ? "bg-emerald-50 text-emerald-700 border border-emerald-100"
              : "bg-red-50 text-red-700 border border-red-100"
          }`}
        >
          {msg.text}
        </div>
      )}

      {/* Revenue share */}
      <div className="card-pad space-y-4">
        <div>
          <label className="label">Revenue share &amp; fees</label>
          <p className="text-xs text-slate-500 mt-0.5">
            Controls how the reporting center splits revenue between RevOS and
            this clinic.
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="label">RevOS down-payment share (%)</label>
            <input
              className="input"
              inputMode="numeric"
              value={downPct}
              onChange={(e) => setDownPct(e.target.value)}
            />
            <p className="text-xs text-slate-400 mt-1">% of each down payment RevOS keeps.</p>
          </div>
          <div>
            <label className="label">Implementor commission ($)</label>
            <input
              className="input"
              inputMode="decimal"
              value={implFee}
              onChange={(e) => setImplFee(e.target.value)}
            />
            <p className="text-xs text-slate-400 mt-1">Paid per down payment.</p>
          </div>
          <div>
            <label className="label">RevOS recurring share ($)</label>
            <input
              className="input"
              inputMode="decimal"
              value={recurShare}
              onChange={(e) => setRecurShare(e.target.value)}
            />
            <p className="text-xs text-slate-400 mt-1">Per subscription cycle.</p>
          </div>
        </div>
        <div className="flex justify-end">
          <button className="btn-primary" onClick={saveShareConfig} disabled={savingShare}>
            {savingShare ? "Saving…" : "Save revenue share"}
          </button>
        </div>
      </div>

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
