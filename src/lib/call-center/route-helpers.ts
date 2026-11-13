/**
 * Shared prologue for /api/call-center/[clinicId]/… route handlers:
 * validate path params (before any Prisma query), then the call-center guard.
 */
import { NextResponse } from "next/server";
import { requireStringParams } from "../route-params";
import { requireCallCenterApi } from "./access";

export async function clinicRoute<T extends string>(
  params: Promise<Partial<Record<"clinicId" | T, unknown>>>,
  extra: readonly T[] = [],
) {
  const p = await requireStringParams(params, ["clinicId", ...extra] as const);
  if (!p.ok) return { error: p.response } as const;
  const guard = await requireCallCenterApi(p.value.clinicId);
  if ("error" in guard) return { error: guard.error } as const;
  return { session: guard.session, clinicId: guard.clinicId, params: p.value } as const;
}

export function bad(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function readJson(req: Request): Promise<unknown> {
  return req.json().catch(() => ({}));
}
