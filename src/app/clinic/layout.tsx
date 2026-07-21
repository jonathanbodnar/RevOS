import { requireClinicContext } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { prisma } from "@/lib/prisma";
import { ImpersonationBanner } from "../admin/impersonation-banner";

export const dynamic = "force-dynamic";

export default async function ClinicLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { session, clinicId } = await requireClinicContext();
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
  const isProvider = session.user.originalRole === "PROVIDER";

  // Providers get a clinical-only workspace: their assigned patients and
  // training. No billing tables, clinic-wide payment links, team, or settings.
  const nav = isProvider
    ? [
        { href: "/clinic", label: "Overview", icon: "home" as const },
        { href: "/clinic/customers", label: "My patients", icon: "users" as const },
        { href: "/clinic/learn", label: "Training", icon: "book" as const },
      ]
    : [
        { href: "/clinic", label: "Overview", icon: "home" as const },
        { href: "/clinic/customers", label: "Customers", icon: "users" as const },
        { href: "/clinic/reports", label: "At-risk patients", icon: "target" as const },
        { href: "/clinic/charges", label: "Transactions", icon: "receipt" as const },
        { href: "/clinic/subscriptions", label: "Subscriptions", icon: "refresh" as const },
        { href: "/clinic/installments", label: "Installments", icon: "calendar" as const },
        { href: "/clinic/invoices", label: "Payment links", icon: "link" as const },
        { href: "/clinic/learn", label: "Training", icon: "book" as const },
        { href: "/clinic/audit", label: "Audit log", icon: "list" as const },
        { href: "/clinic/team", label: "Team", icon: "user" as const },
        { href: "/clinic/settings", label: "Settings", icon: "settings" as const },
      ];

  return (
    <AppShell
      title={clinic?.name ?? "Clinic"}
      subtitle={
        session.user.impersonating
          ? "Super admin view — all actions audit-logged"
          : isProvider
            ? "Provider workspace"
            : "Clinic workspace"
      }
      nav={nav}
      session={session}
      clinicName={clinic?.name}
      banner={<ImpersonationBanner impersonating={session.user.impersonating} />}
    >
      {children}
    </AppShell>
  );
}
