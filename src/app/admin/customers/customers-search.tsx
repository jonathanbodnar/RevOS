"use client";

import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { useEffect, useRef, useState, useTransition } from "react";

type Result = {
  id: string;
  label: string;
  email: string | null;
  phone: string | null;
  clinic: string | null;
  clinicId: string | null;
  isActive: boolean;
};

export function GlobalCustomerSearch() {
  const { update } = useSession();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (q.trim().length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounce.current = setTimeout(async () => {
      const res = await fetch(
        `/api/admin/customers/search?q=${encodeURIComponent(q)}&includeInactive=1`,
      );
      const d = (await res.json().catch(() => ({ results: [] }))) as {
        results: Result[];
      };
      setResults(d.results || []);
      setLoading(false);
    }, 250);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [q]);

  async function openCustomer(r: Result) {
    setError(null);
    if (!r.clinicId) {
      setError("This patient is not assigned to a clinic.");
      return;
    }
    const res = await fetch("/api/admin/impersonate/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clinicId: r.clinicId }),
    });
    if (!res.ok) {
      setError("Unable to open clinic context for this patient.");
      return;
    }
    await update({ impersonatingClinicId: r.clinicId });
    startTransition(() => {
      router.push(`/clinic/customers/${r.id}`);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <input
        className="input max-w-xl"
        placeholder="Search all clinics by name, email, or phone…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        autoFocus
      />
      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-100 rounded-md px-3 py-2">
          {error}
        </div>
      )}
      <div className="card overflow-hidden">
        <table className="table">
          <thead>
            <tr>
              <th>Patient</th>
              <th>Clinic</th>
              <th>Email</th>
              <th>Phone</th>
              <th>Status</th>
              <th className="text-right pr-3">Open</th>
            </tr>
          </thead>
          <tbody>
            {q.trim().length < 2 && (
              <tr>
                <td colSpan={6} className="text-center text-slate-500 py-10">
                  Type at least 2 characters to search across every clinic.
                </td>
              </tr>
            )}
            {q.trim().length >= 2 && loading && (
              <tr>
                <td colSpan={6} className="text-center text-slate-400 py-8">
                  Searching…
                </td>
              </tr>
            )}
            {q.trim().length >= 2 && !loading && results.length === 0 && (
              <tr>
                <td colSpan={6} className="text-center text-slate-500 py-8">
                  No patients found.
                </td>
              </tr>
            )}
            {results.map((r) => (
              <tr key={r.id} className={r.isActive ? undefined : "opacity-60"}>
                <td className="font-medium text-slate-900">{r.label}</td>
                <td className="text-slate-600">{r.clinic ?? "—"}</td>
                <td className="text-slate-600">{r.email ?? "—"}</td>
                <td className="text-slate-600">{r.phone ?? "—"}</td>
                <td>
                  <span className={r.isActive ? "badge-green" : "badge-slate"}>
                    {r.isActive ? "active" : "inactive"}
                  </span>
                </td>
                <td className="text-right pr-3">
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    disabled={pending || !r.clinicId}
                    onClick={() => openCustomer(r)}
                  >
                    Open
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
