import { NextResponse } from "next/server";
import { requireCallCenterUserApi } from "@/lib/call-center/access";
import { agentPhoneToken } from "@/lib/call-center/phone-setup";
import { TelnyxError } from "@/lib/call-center/telnyx";

export const dynamic = "force-dynamic";

/** A 24-hour login token for the signed-in agent's browser phone. */
export async function POST() {
  const g = await requireCallCenterUserApi();
  if ("error" in g) return g.error;
  try {
    const { token } = await agentPhoneToken(g.session.user.id);
    return NextResponse.json({ data: { token } }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof TelnyxError) return NextResponse.json({ error: e.message }, { status: e.status >= 500 ? 502 : e.status });
    throw e;
  }
}
