import { NextResponse } from "next/server";
import { getSession } from "./session";

/**
 * Deny providers a billing action. Providers are scoped to charting/InBody/
 * cards for their assigned patients — never charges, holds, subscriptions, or
 * clinic-wide billing. Returns a 403 response to short-circuit, or null.
 */
export function denyProvider(session: {
  user: { originalRole: string };
}): NextResponse | null {
  if (session.user.originalRole === "PROVIDER") {
    return NextResponse.json(
      { error: "Providers can't perform billing actions." },
      { status: 403 },
    );
  }
  return null;
}

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

/** Require a logged-in super admin (clinic impersonation not required). */
export async function requireSuperAdminApi() {
  const session = await getSession();
  if (!session?.user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (session.user.originalRole !== "SUPER_ADMIN") {
    return {
      error: NextResponse.json(
        { error: "Only super admins can perform this action." },
        { status: 403 },
      ),
    };
  }
  return { session };
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
