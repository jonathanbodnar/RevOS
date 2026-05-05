import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { logAudit } from "@/lib/audit";

export async function POST() {
  const session = await getSession();
  if (session?.user?.originalRole !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId: session.user.effectiveClinicId,
    action: "impersonate.stop",
  });
  return NextResponse.json({ ok: true });
}
