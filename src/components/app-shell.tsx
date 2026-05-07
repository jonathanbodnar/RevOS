import Image from "next/image";
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
  clinicName,
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
  clinicName?: string;
}) {
  return (
    <div className="min-h-screen flex">
      <aside className="w-64 shrink-0 bg-white border-r border-slate-200 flex flex-col">
        <div className="flex flex-col items-center px-5 pt-5 pb-4 border-b border-slate-100 gap-1">
          <Image
            src="/logogrey.png"
            alt="RevOS"
            width={120}
            height={40}
            className="object-contain"
            priority
          />
          {clinicName && (
            <div className="text-xs text-slate-500 font-medium text-center leading-tight mt-1">
              {clinicName}
            </div>
          )}
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
