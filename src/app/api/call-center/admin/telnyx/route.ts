import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit";
import { requireCallCenterAdminApi } from "@/lib/call-center/access";
import { getSetup } from "@/lib/call-center/dialer";
import { setupTelnyx } from "@/lib/call-center/phone-setup";
import { TelnyxError } from "@/lib/call-center/telnyx";

export const dynamic = "force-dynamic";

export async function GET() {
  const g = await requireCallCenterAdminApi();
  if ("error" in g) return g.error;
  return NextResponse.json({ data: await getSetup() });
}

/** Create (or re-point) RevOS's Telnyx objects. Safe to run again. */
export async function POST(req: Request) {
  const g = await requireCallCenterAdminApi();
  if ("error" in g) return g.error;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin;
  try {
    const s = await setupTelnyx(appUrl);
    await logAudit({
      actorId: g.session.user.id,
      actorRole: g.session.user.originalRole,
      action: "telnyx.setup",
      targetType: "CallCenterSettings",
      targetId: "default",
      metadata: { webhookUrl: s.webhookUrl },
    });
    return NextResponse.json({ data: await getSetup() });
  } catch (e) {
    if (e instanceof TelnyxError) return NextResponse.json({ error: e.message }, { status: e.status >= 500 ? 502 : e.status });
    throw e;
  }
}
