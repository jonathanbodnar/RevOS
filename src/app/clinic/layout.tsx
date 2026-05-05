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
        { href: "/clinic", label: "Overview" },
        { href: "/clinic/customers", label: "Customers" },
        { href: "/clinic/charges", label: "Charges" },
        { href: "/clinic/subscriptions", label: "Subscriptions" },
        { href: "/clinic/invoices", label: "Payment links" },
      ]}
      session={session}
      banner={<ImpersonationBanner impersonating={session.user.impersonating} />}
    >
      {children}
    </AppShell>
  );
}
