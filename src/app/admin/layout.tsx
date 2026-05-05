import { requireSuperAdmin } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { ImpersonationBanner } from "./impersonation-banner";

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
        { href: "/admin", label: "Overview" },
        { href: "/admin/clinics", label: "Clinics" },
        { href: "/admin/clinics/new", label: "New clinic" },
        { href: "/admin/audit", label: "Audit log" },
      ]}
      session={session}
      banner={<ImpersonationBanner impersonating={session.user.impersonating} />}
    >
      {children}
    </AppShell>
  );
}
