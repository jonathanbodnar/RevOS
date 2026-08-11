import { requireAdmin } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { ImpersonationBanner } from "./impersonation-banner";
import type { SidebarNavItem } from "@/components/sidebar-nav";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireAdmin();
  const isBilling = session.user.originalRole === "BILLING_DEPT";

  // Billing department: cross-clinic money only (reporting + payouts + costs).
  // No clinic/user management, no impersonation, no InBody/patient PHI tools.
  const nav: SidebarNavItem[] = isBilling
    ? [
        { href: "/admin", label: "Overview", icon: "home" },
        { href: "/admin/reports", label: "Reports", icon: "receipt" },
      ]
    : [
        { href: "/admin", label: "Overview", icon: "home" },
        { href: "/admin/customers", label: "Patients", icon: "users" },
        { href: "/admin/transactions", label: "Transactions", icon: "receipt" },
        { href: "/admin/reports", label: "Reports", icon: "receipt" },
        { href: "/admin/kpis", label: "KPIs", icon: "target" },
        { href: "/admin/clinics", label: "Clinics", icon: "building" },
        { href: "/admin/clinics/new", label: "New clinic", icon: "plus-circle" },
        { href: "/admin/users", label: "Users", icon: "user" },
        { href: "/admin/implementors", label: "Implementors", icon: "users" },
        { href: "/admin/inbody", label: "InBody", icon: "activity" },
        { href: "/admin/learning", label: "Training", icon: "book" },
        { href: "/admin/payment-links", label: "Payment links", icon: "link" },
        { href: "/admin/audit", label: "Audit log", icon: "list" },
        { href: "/account/security", label: "Security", icon: "shield" },
      ];

  return (
    <AppShell
      title={isBilling ? "Billing" : "Super Admin"}
      subtitle={
        isBilling ? "Cross-clinic billing" : "Global control across all clinics"
      }
      nav={nav}
      session={session}
      banner={<ImpersonationBanner impersonating={session.user.impersonating} />}
    >
      {children}
    </AppShell>
  );
}
