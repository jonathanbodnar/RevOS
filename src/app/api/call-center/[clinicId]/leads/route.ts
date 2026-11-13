import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { createLead, listLeads } from "@/lib/call-center/desk-server";
import { bad, clinicRoute, readJson } from "@/lib/call-center/route-helpers";

export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ clinicId: string }> }) {
  const r = await clinicRoute(ctx.params);
  if ("error" in r) return r.error;
  const sp = new URL(req.url).searchParams;
  const page = Number(sp.get("page") || 0);
  const data = await listLeads({
    clinicId: r.clinicId,
    stage: sp.get("stage"),
    q: (sp.get("q") || "").slice(0, 100),
    priorityOnly: sp.get("prio") === "1",
    page: Number.isFinite(page) ? page : 0,
  });
  return NextResponse.json({ data });
}

const Body = z.object({
  firstName: z.string().trim().max(80).optional().nullable(),
  lastName: z.string().trim().max(80).optional().nullable(),
  phone: z.string().trim().min(7).max(30),
  email: z.string().trim().email().max(200).optional().nullable().or(z.literal("")),
  note: z.string().max(2000).optional().nullable(),
  priority: z.boolean().optional(),
  consent: z.boolean().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ clinicId: string }> }) {
  const r = await clinicRoute(ctx.params);
  if ("error" in r) return r.error;
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) return bad("Check the name and phone number.");
  const res = await createLead({ clinicId: r.clinicId, userId: r.session.user.id, ...parsed.data, email: parsed.data.email || null, now: new Date() });
  if (!res.ok) return NextResponse.json({ error: res.error, leadId: "leadId" in res ? res.leadId : undefined }, { status: res.status });
  await logAudit({
    actorId: r.session.user.id,
    actorRole: r.session.user.originalRole,
    clinicId: r.clinicId,
    action: "lead.create",
    targetType: "Lead",
    targetId: res.leadId,
  });
  return NextResponse.json({ data: { id: res.leadId } }, { status: 201 });
}
