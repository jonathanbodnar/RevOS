import Image from "next/image";
import { SignOutButton } from "./sign-out";
import { SidebarNav, type SidebarNavItem } from "./sidebar-nav";

export function AppShell({
  title,
  subtitle,
  nav,
  banner,
  children,
  session,
  clinicName,
  headerAction,
}: {
  title: string;
  subtitle?: string;
  nav: SidebarNavItem[];
  banner?: React.ReactNode;
  children: React.ReactNode;
  session: {
    user: {
      email: string;
      name?: string | null;
      originalRole: "SUPER_ADMIN" | "CLINIC_ADMIN";
    };
  };
  clinicName?: string;
  headerAction?: React.ReactNode;
}) {
  const initials = (session.user.name || session.user.email || "?")
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("") || "?";

  return (
    <div className="min-h-screen flex bg-surface-base">
      <aside className="w-64 shrink-0 bg-white border-r border-line flex flex-col">
        {/* Logo + clinic name */}
        <div className="flex flex-col items-center px-5 pt-7 pb-5 gap-1.5">
          <Image
            src="/logogrey.png"
            alt="RevOS"
            width={120}
            height={40}
            className="object-contain h-9 w-auto"
            priority
          />
          {clinicName ? (
            <div className="text-[11px] text-ink-subtle font-medium tracking-wide text-center mt-0.5">
              {clinicName}
            </div>
          ) : (
            <div className="text-[11px] text-ink-subtle font-medium tracking-wide text-center mt-0.5">
              {session.user.originalRole === "SUPER_ADMIN"
                ? "Super Admin"
                : "Clinic"}
            </div>
          )}
        </div>

        <div className="h-px bg-line mx-3 mb-3" />

        <SidebarNav items={nav} />

        {/* Footer: user info + sign out */}
        <div className="border-t border-line p-3 mt-2">
          <div className="flex items-center gap-2.5 px-2 py-2 mb-1.5">
            <div className="h-8 w-8 shrink-0 rounded-full bg-brand-900 text-white grid place-items-center text-xs font-semibold">
              {initials}
            </div>
            <div className="min-w-0">
              <div className="text-xs font-medium text-ink truncate">
                {session.user.name || session.user.email.split("@")[0]}
              </div>
              <div className="text-[11px] text-ink-subtle truncate">
                {session.user.email}
              </div>
            </div>
          </div>
          <SignOutButton />
        </div>
      </aside>

      <main className="flex-1 min-w-0 flex flex-col">
        {banner}
        <header className="flex items-center justify-between px-10 py-6 bg-surface-base">
          <div>
            <h1 className="text-2xl font-semibold text-ink tracking-tight">
              {title}
            </h1>
            {subtitle && (
              <p className="text-sm text-ink-muted mt-1">{subtitle}</p>
            )}
          </div>
          {headerAction && <div>{headerAction}</div>}
        </header>
        <div className="flex-1 px-10 pb-12">{children}</div>
      </main>
    </div>
  );
}
