import { NextResponse } from "next/server";
import { requireConnectLinkApi } from "@/lib/call-center/connect-link";
import { ImportChunkSchema, readJsonBody, runImportChunk } from "@/lib/call-center/import-server";

export const dynamic = "force-dynamic";

/**
 * Clinic connect link: one chunk (≤ 500 rows) of a spreadsheet upload. No
 * login; the token in the URL is the access.
 *
 * Answers only with counts that come from the upload itself (rows received,
 * rows rejected). Added / updated / already-a-patient counts are left out on
 * purpose: with them, anyone holding the link could upload one phone number
 * and learn whether that person is a lead or patient of the clinic.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const link = await requireConnectLinkApi(req, ctx.params, "upload");
  if ("error" in link) return link.error;

  const raw = await readJsonBody(req);
  if (!raw.ok) return NextResponse.json({ error: raw.error }, { status: raw.status });
  const parsed = ImportChunkSchema.safeParse(raw.value);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const result = await runImportChunk({
    clinicId: link.link.clinicId,
    via: "clinic_link",
    actorId: null,
    actorRole: "CLINIC_LINK",
    linkId: link.link.id,
    // Statuses are guessed on the server and never update existing leads.
    body: { ...parsed.data, options: { ...parsed.data.options, updateStatuses: false } },
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error, importId: result.importId }, { status: result.status });
  }
  return NextResponse.json({
    importId: result.importId,
    done: result.done,
    counts: { received: result.counts.received, invalid: result.counts.invalid },
  });
}
