"use client";

import { useState } from "react";

/**
 * Client-side tab switcher for the customer profile. All tab contents are
 * server-rendered and passed in as nodes; we just toggle visibility so state
 * is preserved and there's no refetch when switching tabs.
 */
export function CustomerTabs({
  overview,
  inbody,
  inbodyCount,
}: {
  overview: React.ReactNode;
  inbody: React.ReactNode;
  inbodyCount: number;
}) {
  const [active, setActive] = useState<"overview" | "inbody">("overview");

  const tabs: { id: "overview" | "inbody"; label: string; badge?: number }[] = [
    { id: "overview", label: "Overview" },
    { id: "inbody", label: "InBody", badge: inbodyCount },
  ];

  return (
    <div>
      <div className="flex gap-1 border-b border-slate-200 mb-6">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setActive(t.id)}
            className={
              active === t.id
                ? "px-4 py-2 text-sm font-medium border-b-2 border-indigo-600 text-indigo-600 -mb-px"
                : "px-4 py-2 text-sm font-medium text-slate-500 hover:text-slate-700 border-b-2 border-transparent -mb-px"
            }
          >
            {t.label}
            {typeof t.badge === "number" && t.badge > 0 && (
              <span className="ml-1.5 text-xs rounded-full bg-slate-100 px-1.5 py-0.5 text-slate-600">
                {t.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className={active === "overview" ? "" : "hidden"}>{overview}</div>
      <div className={active === "inbody" ? "" : "hidden"}>{inbody}</div>
    </div>
  );
}
