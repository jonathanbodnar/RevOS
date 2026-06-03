import { requireSuperAdmin } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { ImpersonationBanner } from "./impersonation-banner";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSuperAdmin();
  return (
    <AppShell
      title="Super Admin"
      subtitle="Global control across all clinics"
      nav={[
        { href: "/admin", label: "Overview", icon: "home" },
        { href: "/admin/reports", label: "Reports", icon: "receipt" },
        { href: "/admin/clinics", label: "Clinics", icon: "building" },
        { href: "/admin/clinics/new", label: "New clinic", icon: "plus-circle" },
        { href: "/admin/implementors", label: "Implementors", icon: "users" },
        { href: "/admin/payment-links", label: "Payment links", icon: "link" },
        { href: "/admin/audit", label: "Audit log", icon: "list" },
      ]}
      session={session}
      banner={<ImpersonationBanner impersonating={session.user.impersonating} />}
    >
      {children}
    </AppShell>
  );
}
