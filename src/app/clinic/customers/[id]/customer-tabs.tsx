"use client";

import { createContext, useCallback, useContext, useState } from "react";

/**
 * Client-side tab switcher for the customer profile. All tab contents are
 * server-rendered and passed in as nodes; we just toggle visibility so state
 * is preserved and there's no refetch when switching tabs.
 */
const TAB_IDS = ["overview", "notes", "chart", "inbody"] as const;
type TabId = (typeof TAB_IDS)[number];

function isTabId(v: unknown): v is TabId {
  return TAB_IDS.includes(v as TabId);
}

// Lets a tab's content keep its badge count in step with edits made in place
// (the notes feed after adding or removing a note) without a server refresh.
const SetBadgeContext = createContext<(tab: TabId, count: number) => void>(
  () => {},
);

export function useSetTabBadge() {
  return useContext(SetBadgeContext);
}

export function CustomerTabs({
  overview,
  notes,
  chart,
  inbody,
  notesCount,
  inbodyCount,
  initialTab,
}: {
  overview: React.ReactNode;
  notes: React.ReactNode;
  chart: React.ReactNode;
  inbody: React.ReactNode;
  notesCount: number;
  inbodyCount: number;
  /** Tab to open first, e.g. from a `?tab=inbody` link. Unknown values fall back to Overview. */
  initialTab?: string;
}) {
  const [active, setActive] = useState<TabId>(
    isTabId(initialTab) ? initialTab : "overview",
  );
  const [badgeOverrides, setBadgeOverrides] = useState<
    Partial<Record<TabId, number>>
  >({});
  const setBadge = useCallback((tab: TabId, count: number) => {
    setBadgeOverrides((prev) =>
      prev[tab] === count ? prev : { ...prev, [tab]: count },
    );
  }, []);

  const tabs: { id: TabId; label: string; badge?: number }[] = [
    { id: "overview", label: "Overview" },
    { id: "notes", label: "Notes", badge: badgeOverrides.notes ?? notesCount },
    { id: "chart", label: "Program chart" },
    { id: "inbody", label: "InBody", badge: badgeOverrides.inbody ?? inbodyCount },
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

      <SetBadgeContext.Provider value={setBadge}>
        <div className={active === "overview" ? "" : "hidden"}>{overview}</div>
        <div className={active === "notes" ? "" : "hidden"}>{notes}</div>
        <div className={active === "chart" ? "" : "hidden"}>{chart}</div>
        <div className={active === "inbody" ? "" : "hidden"}>{inbody}</div>
      </SetBadgeContext.Provider>
    </div>
  );
}
