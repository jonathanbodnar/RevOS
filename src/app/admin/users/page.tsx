import { requireSuperAdmin } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { UsersClient } from "./users-client";

export const dynamic = "force-dynamic";

const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: "Super admin",
  CLINIC_ADMIN: "Clinic admin",
  PROVIDER: "Provider",
  BILLING_DEPT: "Billing dept",
  CALL_AGENT: "Call center",
};

export default async function AdminUsersPage() {
  await requireSuperAdmin();
  const [users, clinics] = await Promise.all([
    prisma.user.findMany({
      orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        clinic: { select: { name: true } },
        _count: { select: { providerAssignments: true } },
        callCenterAccess: { select: { clinicId: true } },
      },
    }),
    prisma.clinic.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Users</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Clinic admins, providers, the billing department and the call
          center. Providers see only the patients assigned to them; billing
          sees cross-clinic reporting; call center users work leads for the
          clinics you pick.
        </p>
      </div>
      <UsersClient
        clinics={clinics}
        users={users.map((u) => ({
          id: u.id,
          name: u.name,
          email: u.email,
          role: u.role,
          roleLabel: ROLE_LABEL[u.role] ?? u.role,
          isActive: u.isActive,
          clinicName: u.clinic?.name ?? null,
          assignmentCount: u._count.providerAssignments,
          callCenterClinicIds: u.callCenterAccess.map((a) => a.clinicId),
        }))}
      />
    </div>
  );
}
