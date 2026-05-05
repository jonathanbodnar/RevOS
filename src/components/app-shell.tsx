import Link from "next/link";
import { SignOutButton } from "./sign-out";

type NavItem = { href: string; label: string };

export function AppShell({
  title,
  subtitle,
  nav,
  banner,
  children,
  session,
}: {
  title: string;
  subtitle?: string;
  nav: NavItem[];
  banner?: React.ReactNode;
  children: React.ReactNode;
  session: {
    user: {
      email: string;
      name?: string | null;
      originalRole: "SUPER_ADMIN" | "CLINIC_ADMIN";
    };
  };
}) {
  return (
    <div className="min-h-screen flex">
      <aside className="w-64 shrink-0 bg-white border-r border-slate-200 flex flex-col">
        <div className="h-16 flex items-center gap-3 px-5 border-b border-slate-100">
          <div className="h-8 w-8 rounded-lg bg-brand-600 text-white grid place-items-center font-bold">
            R
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">RevOS</div>
            <div className="text-[11px] text-slate-500">
              {session.user.originalRole === "SUPER_ADMIN"
                ? "Super Admin"
                : "Clinic"}
            </div>
          </div>
        </div>
        <nav className="p-3 space-y-0.5 flex-1">
          {nav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="block rounded-md px-3 py-2 text-sm text-slate-700 hover:bg-slate-100"
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="p-3 border-t border-slate-100 text-xs text-slate-500">
          <div className="truncate mb-2">{session.user.email}</div>
          <SignOutButton />
        </div>
      </aside>
      <main className="flex-1 min-w-0">
        {banner}
        <header className="h-16 flex items-center px-8 border-b border-slate-100 bg-white">
          <div>
            <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
            {subtitle && (
              <p className="text-xs text-slate-500">{subtitle}</p>
            )}
          </div>
        </header>
        <div className="p-8">{children}</div>
      </main>
    </div>
  );
}
