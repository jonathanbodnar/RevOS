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
