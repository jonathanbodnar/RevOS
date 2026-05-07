/**
 * Helpers for safely extracting Next.js App Router path params.
 *
 * Although the framework only ever supplies strings for `[name]` segments,
 * SAST tools (and any future framework changes) can't prove that statically,
 * so we coerce/validate explicitly before using a value in a Prisma query.
 *
 * This shuts down NoSQL-operator-injection style alerts and provides
 * defense-in-depth: any non-string value short-circuits with a 400 instead
 * of being passed unchanged to the ORM.
 */
import { NextResponse } from "next/server";

export type ParamResult<T extends string> =
  | { ok: true; value: Record<T, string> }
  | { ok: false; response: NextResponse };

export async function requireStringParams<T extends string>(
  params: Promise<Partial<Record<T, unknown>>>,
  keys: readonly T[],
): Promise<ParamResult<T>> {
  const resolved = await params;
  const out = {} as Record<T, string>;
  for (const k of keys) {
    const v = resolved[k];
    if (typeof v !== "string" || v.length === 0) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: `Invalid path parameter: ${String(k)}` },
          { status: 400 },
        ),
      };
    }
    out[k] = v;
  }
  return { ok: true, value: out };
}
