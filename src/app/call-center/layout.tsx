import { AppShell } from "@/components/app-shell";
import type { SidebarNavItem } from "@/components/sidebar-nav";
import { requireCallCenterPage } from "@/lib/call-center/access";

export const dynamic = "force-dynamic";

export default async function CallCenterLayout({ children }: { children: React.ReactNode }) {
  const session = await requireCallCenterPage();
  const isSuper = session.user.originalRole === "SUPER_ADMIN";
  const nav: SidebarNavItem[] = isSuper
    ? [
        { href: "/call-center", label: "Clinics", icon: "phone" },
        { href: "/call-center/phone-setup", label: "Phone setup", icon: "settings" },
        { href: "/admin", label: "Back to admin", icon: "chevron-left" },
      ]
    : [{ href: "/call-center", label: "Clinics", icon: "phone" }];
  return (
    <AppShell
      title="Call center"
      subtitle={isSuper ? "Calls for every clinic, one clinic at a time" : "Calls for your clinics, one clinic at a time"}
      nav={nav}
      session={session}
      hideChat
    >
      {children}
    </AppShell>
  );
}
