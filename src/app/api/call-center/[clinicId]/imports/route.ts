import { NextResponse } from "next/server";
import { requireCallCenterApi } from "@/lib/call-center/access";
import {
  ImportChunkSchema,
  readJsonBody,
  recentImports,
  runImportChunk,
} from "@/lib/call-center/import-server";
import { requireStringParams } from "@/lib/route-params";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ clinicId: string }> };

/** Recent imports for a clinic (counts only). */
export async function GET(_req: Request, ctx: Ctx) {
  const params = await requireStringParams(ctx.params, ["clinicId"] as const);
  if (!params.ok) return params.response;
  const guard = await requireCallCenterApi(params.value.clinicId);
  if ("error" in guard) return guard.error;
  return NextResponse.json({ imports: await recentImports(guard.clinicId) });
}

/**
 * One chunk (≤ 500 rows) of a file import. The first chunk starts the import
 * and returns its id; later chunks send it; the last sends done: true.
 */
export async function POST(req: Request, ctx: Ctx) {
  const params = await requireStringParams(ctx.params, ["clinicId"] as const);
  if (!params.ok) return params.response;
  const guard = await requireCallCenterApi(params.value.clinicId);
  if ("error" in guard) return guard.error;

  const raw = await readJsonBody(req);
  if (!raw.ok) return NextResponse.json({ error: raw.error }, { status: raw.status });
  const parsed = ImportChunkSchema.safeParse(raw.value);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const result = await runImportChunk({
    clinicId: guard.clinicId,
    via: "staff",
    actorId: guard.session.user.id,
    actorRole: guard.session.user.originalRole,
    linkId: null,
    body: parsed.data,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error, importId: result.importId }, { status: result.status });
  }
  return NextResponse.json(result);
}
