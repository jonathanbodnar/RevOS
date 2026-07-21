import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "./auth";

export async function getSession() {
  return getServerSession(authOptions);
}

export async function requireSession() {
  const session = await getSession();
  if (!session?.user) redirect("/login");
  return session;
}

export async function requireSuperAdmin() {
  const session = await requireSession();
  if (session.user.originalRole !== "SUPER_ADMIN") redirect("/");
  return session;
}

/** Admin area: super admin OR billing department (billing gets a reduced nav). */
export async function requireAdmin() {
  const session = await requireSession();
  const role = session.user.originalRole;
  if (role !== "SUPER_ADMIN" && role !== "BILLING_DEPT") redirect("/");
  return session;
}

/**
 * Require a session with clinic context — either a clinic-admin, or a
 * super-admin who is currently impersonating a clinic.
 */
export async function requireClinicContext() {
  const session = await requireSession();
  const clinicId = session.user.effectiveClinicId;
  if (!clinicId) {
    // super-admin not impersonating — send to the admin home
    if (session.user.originalRole === "SUPER_ADMIN") redirect("/admin");
    redirect("/login");
  }
  return { session, clinicId: clinicId as string };
}

export function isSuperAdmin(
  session: { user: { originalRole: string } } | null,
) {
  return session?.user?.originalRole === "SUPER_ADMIN";
}

/**
 * Clinic context that EXCLUDES providers — for billing/admin surfaces inside a
 * clinic (transactions, subscriptions, team, settings) that providers must not
 * see. Providers are bounced to their overview.
 */
export async function requireClinicAdminContext() {
  const ctx = await requireClinicContext();
  if (ctx.session.user.originalRole === "PROVIDER") redirect("/clinic");
  return ctx;
}
