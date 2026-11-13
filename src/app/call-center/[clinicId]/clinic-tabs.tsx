"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const TABS = [
  { href: "", label: "Today" },
  { href: "/leads", label: "Leads" },
  { href: "/report", label: "Report" },
  { href: "/import", label: "Import" },
  { href: "/rules", label: "Call rules" },
];

export function ClinicTabs({
  clinicId,
  clinicName,
  clinics,
}: {
  clinicId: string;
  clinicName: string;
  clinics: { id: string; name: string }[];
}) {
  const pathname = usePathname() || "";
  const router = useRouter();
  const base = `/call-center/${clinicId}`;
  const rest = pathname.slice(base.length);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
      <div className="flex items-center gap-3 min-w-0">
        {clinics.length > 1 ? (
          <select
            aria-label="Clinic"
            className="input !w-auto !py-1.5 font-semibold"
            value={clinicId}
            onChange={(e) => router.push(`/call-center/${e.target.value}${rest}`)}
          >
            {clinics.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        ) : (
          <div className="text-base font-semibold text-ink truncate">{clinicName}</div>
        )}
      </div>
      <nav className="flex flex-wrap gap-1" aria-label="Call center">
        {TABS.map((t) => {
          const href = base + t.href;
          const active = t.href === "" ? pathname === base : pathname.startsWith(href);
          return (
            <Link
              key={t.label}
              href={href}
              aria-current={active ? "page" : undefined}
              className={active ? "nav-link-active !py-1.5" : "nav-link !py-1.5"}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
