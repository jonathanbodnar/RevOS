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

  return (
    <AppShell
      title={clinic?.name ?? "Clinic"}
      subtitle={
        session.user.impersonating
          ? "Super admin view — all actions audit-logged"
          : "Clinic workspace"
      }
      nav={[
        { href: "/clinic", label: "Overview", icon: "home" },
        { href: "/clinic/customers", label: "Customers", icon: "users" },
        { href: "/clinic/charges", label: "Transactions", icon: "receipt" },
        { href: "/clinic/subscriptions", label: "Subscriptions", icon: "refresh" },
        { href: "/clinic/installments", label: "Installments", icon: "calendar" },
        { href: "/clinic/invoices", label: "Payment links", icon: "link" },
        { href: "/clinic/team", label: "Team", icon: "user" },
        { href: "/clinic/settings", label: "Settings", icon: "settings" },
      ]}
      session={session}
      clinicName={clinic?.name}
      banner={<ImpersonationBanner impersonating={session.user.impersonating} />}
    >
      {children}
    </AppShell>
  );
}
