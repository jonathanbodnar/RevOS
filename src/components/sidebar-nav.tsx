"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon, type IconName } from "./icon";

export type SidebarNavItem = {
  href: string;
  label: string;
  icon?: IconName;
};

export function SidebarNav({ items }: { items: SidebarNavItem[] }) {
  const pathname = usePathname() || "";

  return (
    <nav className="px-3 space-y-0.5 flex-1 overflow-y-auto">
      {items.map((item) => {
        const active = isActive(pathname, item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={active ? "nav-link-active" : "nav-link"}
          >
            {item.icon && (
              <Icon
                name={item.icon}
                className={`h-[18px] w-[18px] shrink-0 ${
                  active ? "text-white" : "text-ink-subtle"
                }`}
              />
            )}
            <span className="truncate">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * A nav item is "active" when the current path is the item's href, or a
 * descendant of it. Exception: the bare section roots like `/admin` and
 * `/clinic` should only highlight when on that exact route — otherwise
 * every page would also light up "Overview".
 */
function isActive(pathname: string, href: string): boolean {
  const exactRoots = ["/admin", "/clinic"];
  if (exactRoots.includes(href)) return pathname === href;
  return pathname === href || pathname.startsWith(href + "/");
}
