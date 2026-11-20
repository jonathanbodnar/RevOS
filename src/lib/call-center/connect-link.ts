/**
 * The clinic connect link: one page, no RevOS login, where a clinic connects
 * its CRM and uploads lead files (/connect/<token>).
 *
 * The token is 32 random bytes, base64url (43 characters). Lookups use only
 * its sha256 (tokenHash); the token itself is stored encrypted (tokenEnc) so
 * staff can copy the link again. A link works until it expires (30 days by
 * default) or is revoked, and a clinic has one live link at a time.
 *
 * The public API under /api/public/connect/[token]/… goes through
 * requireConnectLinkApi: valid live token, per-IP and per-link rate limits.
 */
import crypto from "crypto";
import { NextResponse } from "next/server";
import { prisma } from "../prisma";
import { decryptField, encryptField, isDecryptFailure } from "../encryption";
import { requireStringParams } from "../route-params";

export const DEFAULT_LINK_DAYS = 30;
export const MAX_LINK_DAYS = 90;
export const EXPIRED_MESSAGE = "This link has expired. Ask your RevOS contact for a new one.";
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function newConnectToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashConnectToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function isWellFormedToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN_RE.test(token);
}

/** Public URL of a link. NEXT_PUBLIC_APP_URL wins over the request origin. */
export function connectLinkUrl(token: string, origin?: string | null): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL || origin || "").replace(/\/+$/, "");
  return `${base}/connect/${token}`;
}

export type LinkState = "active" | "expired" | "revoked";

export function linkState(link: { revokedAt: Date | null; expiresAt: Date | null }, now = new Date()): LinkState {
  if (link.revokedAt) return "revoked";
  if (link.expiresAt && link.expiresAt.getTime() <= now.getTime()) return "expired";
  return "active";
}

/** Create a clinic's link, revoking any live one it replaces. */
export async function createConnectLink(input: {
  clinicId: string;
  createdById: string | null;
  days?: number;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const days = Math.min(Math.max(Math.round(input.days ?? DEFAULT_LINK_DAYS), 1), MAX_LINK_DAYS);
  const token = newConnectToken();
  const tokenEnc = encryptField(token);
  if (!tokenEnc) throw new Error("Could not store the link token.");
  const replaced = await prisma.clinicConnectLink.updateMany({
    where: { clinicId: input.clinicId, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    data: { revokedAt: now },
  });
  const link = await prisma.clinicConnectLink.create({
    data: {
      clinicId: input.clinicId,
      tokenHash: hashConnectToken(token),
      tokenEnc,
      createdById: input.createdById,
      expiresAt: new Date(now.getTime() + days * 86_400_000),
    },
    select: { id: true, expiresAt: true, createdAt: true },
  });
  return { link, token, replaced: replaced.count };
}

export type FoundLink =
  | {
      ok: true;
      link: { id: string; clinicId: string; expiresAt: Date | null };
      clinic: { id: string; name: string; logoUrl: string | null };
    }
  | { ok: false; reason: "invalid" | "revoked" | "expired" };

/** Look up a live link by its token. Never throws for a bad token. */
export async function findConnectLink(token: unknown, now = new Date()): Promise<FoundLink> {
  if (!isWellFormedToken(token)) return { ok: false, reason: "invalid" };
  const link = await prisma.clinicConnectLink.findUnique({
    where: { tokenHash: hashConnectToken(token) },
    select: {
      id: true,
      clinicId: true,
      expiresAt: true,
      revokedAt: true,
      clinic: { select: { id: true, name: true, logoUrl: true, isActive: true } },
    },
  });
  if (!link || !link.clinic?.isActive) return { ok: false, reason: "invalid" };
  const state = linkState(link, now);
  if (state !== "active") return { ok: false, reason: state };
  return {
    ok: true,
    link: { id: link.id, clinicId: link.clinicId, expiresAt: link.expiresAt },
    clinic: { id: link.clinic.id, name: link.clinic.name, logoUrl: link.clinic.logoUrl },
  };
}

/** Record that a link was used. Best effort. */
export async function touchConnectLink(id: string): Promise<void> {
  try {
    await prisma.clinicConnectLink.update({ where: { id }, data: { lastUsedAt: new Date() } });
  } catch (e) {
    console.error("[connect-link] could not record use", e);
  }
}

/** Revoke one of a clinic's links. False when there was no live link with that id. */
export async function revokeConnectLink(clinicId: string, linkId: string, now = new Date()): Promise<boolean> {
  const res = await prisma.clinicConnectLink.updateMany({
    where: { id: linkId, clinicId, revokedAt: null },
    data: { revokedAt: now },
  });
  return res.count > 0;
}

export type ConnectLinkView = {
  id: string;
  state: LinkState;
  /** Only for the live link. */
  url: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
};

/** A clinic's recent links for staff, with the URL of the live one. */
export async function listConnectLinks(clinicId: string, origin?: string | null): Promise<ConnectLinkView[]> {
  const links = await prisma.clinicConnectLink.findMany({
    where: { clinicId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: { id: true, tokenEnc: true, createdAt: true, expiresAt: true, revokedAt: true, lastUsedAt: true },
  });
  const now = new Date();
  return links.map((l) => {
    const state = linkState(l, now);
    let url: string | null = null;
    if (state === "active") {
      const token = decryptField(l.tokenEnc);
      if (token && !isDecryptFailure(token) && isWellFormedToken(token)) url = connectLinkUrl(token, origin);
    }
    return {
      id: l.id,
      state,
      url,
      createdAt: l.createdAt.toISOString(),
      expiresAt: l.expiresAt?.toISOString() ?? null,
      revokedAt: l.revokedAt?.toISOString() ?? null,
      lastUsedAt: l.lastUsedAt?.toISOString() ?? null,
    };
  });
}

// ── Rate limits (in-process, per instance) ─────────────────────────────────

type Limit = { max: number; windowMs: number };
export const LINK_LIMITS = {
  /** Any request from one address, checked before the token lookup. */
  ip: { max: 600, windowMs: 10 * 60_000 },
  /** Upload chunks and syncs per link and address (50,000 rows is 100 chunks). */
  upload: { max: 240, windowMs: 10 * 60_000 },
  /** Connect attempts (API keys tried) per link and address. */
  connect: { max: 20, windowMs: 10 * 60_000 },
} satisfies Record<string, Limit>;

const HITS = new Map<string, { n: number; resetAt: number }>();

/** Count a hit; true once `key` is over its limit for the current window. */
export function rateLimited(key: string, limit: Limit, now = Date.now()): boolean {
  if (HITS.size > 10_000) {
    for (const [k, v] of HITS) if (now > v.resetAt) HITS.delete(k);
  }
  const cur = HITS.get(key);
  if (!cur || now > cur.resetAt) {
    HITS.set(key, { n: 1, resetAt: now + limit.windowMs });
    return false;
  }
  cur.n += 1;
  return cur.n > limit.max;
}

/** For tests. */
export function resetRateLimits(): void {
  HITS.clear();
}

/** The caller's address (Railway puts the client first in X-Forwarded-For). */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  const ip = fwd?.split(",")[0]?.trim() || req.headers.get("x-real-ip")?.trim();
  return ip ? ip.slice(0, 64) : "unknown";
}

export type LinkApiOk = Extract<FoundLink, { ok: true }> & { ip: string };

/**
 * Guard for /api/public/connect/[token]/… routes: a well-formed, live token
 * and rate limits. 404 with the expired message for any bad token, so a
 * revoked link and a made-up one look the same.
 */
export async function requireConnectLinkApi(
  req: Request,
  params: Promise<{ token?: unknown }>,
  kind: "upload" | "connect",
): Promise<LinkApiOk | { error: NextResponse }> {
  const parsed = await requireStringParams(params, ["token"] as const);
  if (!parsed.ok) return { error: parsed.response };
  const ip = clientIp(req);
  const tooMany = () =>
    NextResponse.json({ error: "Too many tries. Wait a few minutes and try again." }, { status: 429 });
  if (rateLimited(`ip:${ip}`, LINK_LIMITS.ip)) return { error: tooMany() };
  const found = await findConnectLink(parsed.value.token);
  if (!found.ok) return { error: NextResponse.json({ error: EXPIRED_MESSAGE }, { status: 404 }) };
  if (rateLimited(`${kind}:${found.link.id}:${ip}`, LINK_LIMITS[kind])) return { error: tooMany() };
  await touchConnectLink(found.link.id);
  return { ...found, ip };
}
