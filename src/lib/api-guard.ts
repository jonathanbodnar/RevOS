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
