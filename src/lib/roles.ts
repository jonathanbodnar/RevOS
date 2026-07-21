/**
 * Role helpers + customer-access scoping.
 *
 * Roles:
 *  - SUPER_ADMIN  — everything, plus clinic impersonation.
 *  - BILLING_DEPT — cross-clinic reporting / payouts / advanced costs. No
 *    clinic or user management, no impersonation, no refunds.
 *  - CLINIC_ADMIN — full workspace for their own clinic.
 *  - PROVIDER     — their clinic, but ONLY their assigned customers; charting,
 *    InBody, payment links, saving cards. No refunds/deletes (those already
 *    require super admin).
 */

export type AppRole =
  | "SUPER_ADMIN"
  | "CLINIC_ADMIN"
  | "PROVIDER"
  | "BILLING_DEPT";

export type SessionUser = {
  id: string;
  originalRole: string;
  effectiveClinicId: string | null;
};

export function isSuperAdminRole(role: string): boolean {
  return role === "SUPER_ADMIN";
}
export function isProviderRole(role: string): boolean {
  return role === "PROVIDER";
}
export function isBillingRole(role: string): boolean {
  return role === "BILLING_DEPT";
}
/** Can this role open the /admin area at all (super admin or billing)? */
export function canAccessAdmin(role: string): boolean {
  return role === "SUPER_ADMIN" || role === "BILLING_DEPT";
}

/**
 * Prisma `where` fragment limiting which customers a session may see inside a
 * clinic. Providers are restricted to their assignments; everyone else with
 * clinic context sees the whole clinic. Spread into a customer query:
 *
 *   where: { ...customerScopeWhere(user, clinicId) }
 */
export function customerScopeWhere(
  user: SessionUser,
  clinicId: string,
): Record<string, unknown> {
  if (isProviderRole(user.originalRole)) {
    return {
      clinicId,
      providerAssignments: { some: { providerId: user.id } },
    };
  }
  return { clinicId };
}
