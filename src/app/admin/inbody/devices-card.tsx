"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { formatDate } from "@/lib/format";

export type DeviceRow = {
  id: string;
  serial: string;
  label: string | null;
  clinicId: string | null;
  clinicName: string | null;
  lastSeenAt: string | null;
  scans: number;
  unattributed: number;
};

/**
 * Which clinic each InBody unit sits in. A unit's serial is stamped on every
 * scan, so assigning it here is what lets an unmapped walk-in still show a
 * location.
 */
export function DevicesCard({
  devices,
  clinics,
}: {
  devices: DeviceRow[];
  clinics: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function assign(device: DeviceRow, clinicId: string) {
    setBusy(device.id);
    setNote(null);
    const res = await fetch(`/api/admin/inbody/devices/${device.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clinicId: clinicId || null, applyToExisting: true }),
    });
    const d = (await res.json().catch(() => ({}))) as {
      updatedScans?: number;
      error?: string;
    };
    setBusy(null);
    setNote(
      res.ok
        ? `${device.serial} assigned${d.updatedScans ? ` — ${d.updatedScans} existing scan${d.updatedScans === 1 ? "" : "s"} attributed` : ""}.`
        : `Error: ${d.error || "could not assign"}`,
    );
    startTransition(() => router.refresh());
  }

  const unassigned = devices.filter((d) => !d.clinicId).length;

  return (
    <div className="card-pad space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-900">InBody devices</div>
        {unassigned > 0 && (
          <span className="badge-yellow text-xs">{unassigned} unassigned</span>
        )}
      </div>
      <p className="text-xs text-slate-500">
        Each unit lives at one clinic. Assigning it here is what lets a scan
        show a location even when the person never became a patient.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Serial</th>
            <th>Clinic</th>
            <th>Scans</th>
            <th>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {devices.length === 0 && (
            <tr>
              <td colSpan={4} className="text-center text-slate-500 py-4">
                No devices seen yet.
              </td>
            </tr>
          )}
          {devices.map((d) => (
            <tr key={d.id}>
              <td className="text-xs font-medium text-slate-700">
                {d.serial}
                {d.label && <div className="text-slate-400">{d.label}</div>}
              </td>
              <td>
                <select
                  className="input text-xs py-0.5 px-1 w-52"
                  value={d.clinicId ?? ""}
                  disabled={busy === d.id}
                  onChange={(e) => assign(d, e.target.value)}
                  aria-label={`Clinic for ${d.serial}`}
                >
                  <option value="">— unassigned —</option>
                  {clinics.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                {d.unattributed > 0 && d.clinicId && (
                  <div className="text-xs text-amber-600 mt-0.5">
                    {d.unattributed} scan{d.unattributed === 1 ? "" : "s"} still without a clinic
                  </div>
                )}
              </td>
              <td className="text-xs text-slate-600">{d.scans}</td>
              <td className="text-xs text-slate-500">
                {d.lastSeenAt ? formatDate(d.lastSeenAt) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {note && <p className="text-xs text-slate-600">{note}</p>}
    </div>
  );
}
