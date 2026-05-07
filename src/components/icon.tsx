import type { SVGProps } from "react";

/**
 * Lightweight icon set drawn as inline SVGs. Keeps dependencies down and
 * lets us style with `currentColor`. All icons share the same 24x24 viewbox
 * with a consistent 1.75px stroke for visual harmony.
 */

export type IconName =
  | "home"
  | "building"
  | "plus-circle"
  | "users"
  | "user"
  | "receipt"
  | "refresh"
  | "link"
  | "list"
  | "logout"
  | "chevron-right"
  | "chevron-left"
  | "shield"
  | "settings";

const COMMON: SVGProps<SVGSVGElement> = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
};

export function Icon({
  name,
  className = "h-4 w-4",
}: {
  name: IconName;
  className?: string;
}) {
  switch (name) {
    case "home":
      return (
        <svg {...COMMON} className={className}>
          <path d="M3 10.5 12 3l9 7.5" />
          <path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5" />
        </svg>
      );
    case "building":
      return (
        <svg {...COMMON} className={className}>
          <rect x="4" y="3" width="16" height="18" rx="2" />
          <path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2" />
          <path d="M10 21v-3h4v3" />
        </svg>
      );
    case "plus-circle":
      return (
        <svg {...COMMON} className={className}>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v8M8 12h8" />
        </svg>
      );
    case "users":
      return (
        <svg {...COMMON} className={className}>
          <path d="M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19" />
          <circle cx="10" cy="8" r="3.5" />
          <path d="M20 19v-1.5a3.5 3.5 0 0 0-2.625-3.387" />
          <path d="M15 4.5a3.5 3.5 0 0 1 0 6.5" />
        </svg>
      );
    case "user":
      return (
        <svg {...COMMON} className={className}>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21v-1.5A5.5 5.5 0 0 1 9.5 14h5a5.5 5.5 0 0 1 5.5 5.5V21" />
        </svg>
      );
    case "receipt":
      return (
        <svg {...COMMON} className={className}>
          <path d="M5 3h14v18l-2.5-1.5L14 21l-2-1.5L10 21l-2.5-1.5L5 21z" />
          <path d="M8 8h8M8 12h8M8 16h5" />
        </svg>
      );
    case "refresh":
      return (
        <svg {...COMMON} className={className}>
          <path d="M21 12a9 9 0 1 1-3.5-7.1" />
          <path d="M21 4v5h-5" />
        </svg>
      );
    case "link":
      return (
        <svg {...COMMON} className={className}>
          <path d="M10 14a4 4 0 0 1 0-5.65l3.5-3.5a4 4 0 0 1 5.65 5.65l-1.4 1.4" />
          <path d="M14 10a4 4 0 0 1 0 5.65l-3.5 3.5a4 4 0 0 1-5.65-5.65l1.4-1.4" />
        </svg>
      );
    case "list":
      return (
        <svg {...COMMON} className={className}>
          <path d="M8 6h13M8 12h13M8 18h13" />
          <circle cx="4" cy="6" r="1" fill="currentColor" stroke="none" />
          <circle cx="4" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="4" cy="18" r="1" fill="currentColor" stroke="none" />
        </svg>
      );
    case "logout":
      return (
        <svg {...COMMON} className={className}>
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <path d="M16 17l5-5-5-5" />
          <path d="M21 12H9" />
        </svg>
      );
    case "chevron-right":
      return (
        <svg {...COMMON} className={className}>
          <path d="m9 6 6 6-6 6" />
        </svg>
      );
    case "chevron-left":
      return (
        <svg {...COMMON} className={className}>
          <path d="m15 6-6 6 6 6" />
        </svg>
      );
    case "shield":
      return (
        <svg {...COMMON} className={className}>
          <path d="M12 3 4 6v6c0 4.5 3.2 8.4 8 9 4.8-.6 8-4.5 8-9V6z" />
        </svg>
      );
    case "settings":
      return (
        <svg {...COMMON} className={className}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
  }
}
