import { NextResponse } from "next/server";
import { getSession } from "./session";

/**
 * Require an authenticated session with clinic context. Returns a tuple of
 * `[session, clinicId]` on success, or a NextResponse to short-circuit.
 */
export async function requireClinicApi() {
  const session = await getSession();
  if (!session?.user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const clinicId = session.user.effectiveClinicId;
  if (!clinicId) {
    return {
      error: NextResponse.json(
        { error: "No clinic context on session" },
        { status: 400 },
      ),
    };
  }
  return { session, clinicId };
}

/**
 * Require super admin (or super admin impersonating) for sensitive operations
 * like refunds and removing payment methods.
 */
export async function requireSuperAdminClinicApi() {
  const guard = await requireClinicApi();
  if ("error" in guard) return guard;
  const { session, clinicId } = guard;
  if (session.user.originalRole !== "SUPER_ADMIN") {
    return {
      error: NextResponse.json(
        { error: "Only super admins can perform this action." },
        { status: 403 },
      ),
    };
  }
  return { session, clinicId };
}
