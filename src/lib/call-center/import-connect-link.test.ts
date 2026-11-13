/**
 * Clinic connect link tokens (src/lib/call-center/connect-link.ts): creation,
 * lookup by hash only, revoked/expired links, staff copy-again URLs and the
 * public rate limits. Database calls are mocks.
 */
import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { prisma } from "../prisma";
import { isolatePrisma } from "../test-helpers/prisma";
import { decryptField, encryptField } from "../encryption";
import {
  clientIp,
  connectLinkUrl,
  createConnectLink,
  EXPIRED_MESSAGE,
  findConnectLink,
  hashConnectToken,
  isWellFormedToken,
  linkState,
  listConnectLinks,
  newConnectToken,
  rateLimited,
  requireConnectLinkApi,
  resetRateLimits,
} from "./connect-link";

process.env.FIELD_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
process.env.NEXT_PUBLIC_APP_URL = "https://revos.example.test/";

const NOW = new Date("2026-11-13T18:00:00Z");
const clinic = { id: "clinic-1", name: "Downtown Med Spa", logoUrl: null, isActive: true };

let restore: () => void;
beforeEach(() => {
  restore = isolatePrisma();
  resetRateLimits();
});
afterEach(() => {
  mock.restoreAll();
  restore();
});

test("tokens are 32 random bytes, url-safe, and only their sha256 is looked up", () => {
  const a = newConnectToken();
  const b = newConnectToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(a, "base64url").length, 32);
  assert.equal(hashConnectToken(a), crypto.createHash("sha256").update(a).digest("hex"));
  assert.equal(isWellFormedToken(a), true);
  for (const bad of ["", "short", `${a}x`, `${a.slice(0, 42)}/`, { $ne: "" }, ["x"], null, 42]) {
    assert.equal(isWellFormedToken(bad), false);
  }
});

test("creating a link revokes the live one, stores hash + encrypted token, and expires in 30 days", async () => {
  const revokeOld = mock.method(prisma.clinicConnectLink, "updateMany", async () => ({ count: 1 }));
  const create = mock.method(prisma.clinicConnectLink, "create", async (args: { data: Record<string, unknown> }) => ({
    id: "link-2",
    expiresAt: args.data.expiresAt,
    createdAt: NOW,
  }));
  const { token, replaced, link } = await createConnectLink({ clinicId: "clinic-1", createdById: "agent-1", now: NOW });
  assert.equal(replaced, 1);
  assert.deepEqual(revokeOld.mock.calls[0].arguments[0], {
    where: { clinicId: "clinic-1", revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: NOW } }] },
    data: { revokedAt: NOW },
  });
  const data = create.mock.calls[0].arguments[0]?.data as Record<string, unknown>;
  assert.equal(data.tokenHash, hashConnectToken(token));
  assert.match(String(data.tokenEnc), /^enc:v1:/);
  assert.equal(decryptField(data.tokenEnc as string), token);
  assert.notEqual(data.tokenEnc, token);
  assert.deepEqual(link.expiresAt, new Date(NOW.getTime() + 30 * 86_400_000));

  await createConnectLink({ clinicId: "clinic-1", createdById: null, days: 900, now: NOW });
  const capped = create.mock.calls[1].arguments[0]?.data as { expiresAt: Date };
  assert.deepEqual(capped.expiresAt, new Date(NOW.getTime() + 90 * 86_400_000), "at most 90 days");
});

test("malformed tokens never reach the database", async () => {
  const find = mock.method(prisma.clinicConnectLink, "findUnique", async () => {
    throw new Error("should not be called");
  });
  for (const t of ["", "abc", "../../etc", { not: "" }, null]) {
    assert.deepEqual(await findConnectLink(t), { ok: false, reason: "invalid" });
  }
  assert.equal(find.mock.callCount(), 0);
});

test("lookup: unknown, revoked, expired and inactive-clinic links are refused", async () => {
  const token = newConnectToken();
  const rows: Record<string, unknown>[] = [];
  const find = mock.method(prisma.clinicConnectLink, "findUnique", async () => rows.shift() ?? null);
  const base = { id: "link-1", clinicId: "clinic-1", expiresAt: new Date("2026-12-01"), revokedAt: null, clinic };

  assert.deepEqual(await findConnectLink(token, NOW), { ok: false, reason: "invalid" });
  rows.push({ ...base, revokedAt: new Date("2026-11-01") });
  assert.deepEqual(await findConnectLink(token, NOW), { ok: false, reason: "revoked" });
  rows.push({ ...base, expiresAt: new Date("2026-11-13T17:59:59Z") });
  assert.deepEqual(await findConnectLink(token, NOW), { ok: false, reason: "expired" });
  rows.push({ ...base, clinic: { ...clinic, isActive: false } });
  assert.deepEqual(await findConnectLink(token, NOW), { ok: false, reason: "invalid" });
  rows.push(base);
  assert.deepEqual(await findConnectLink(token, NOW), {
    ok: true,
    link: { id: "link-1", clinicId: "clinic-1", expiresAt: base.expiresAt },
    clinic: { id: "clinic-1", name: "Downtown Med Spa", logoUrl: null },
  });
  assert.deepEqual(find.mock.calls[0].arguments[0]?.where, { tokenHash: hashConnectToken(token) });
});

test("link state: revoked beats expired; no expiry means active", () => {
  assert.equal(linkState({ revokedAt: null, expiresAt: null }, NOW), "active");
  assert.equal(linkState({ revokedAt: null, expiresAt: NOW }, NOW), "expired");
  assert.equal(linkState({ revokedAt: NOW, expiresAt: new Date(0) }, NOW), "revoked");
});

test("staff list: only the live link carries its URL, rebuilt from the encrypted token", async () => {
  const token = newConnectToken();
  mock.method(prisma.clinicConnectLink, "findMany", async () => [
    { id: "live", tokenEnc: encryptField(token), createdAt: NOW, expiresAt: new Date(Date.now() + 86_400_000), revokedAt: null, lastUsedAt: null },
    { id: "old", tokenEnc: encryptField(newConnectToken()), createdAt: NOW, expiresAt: null, revokedAt: NOW, lastUsedAt: NOW },
    { id: "gone", tokenEnc: encryptField(newConnectToken()), createdAt: NOW, expiresAt: new Date(0), revokedAt: null, lastUsedAt: null },
    { id: "lost-key", tokenEnc: "enc:v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", createdAt: NOW, expiresAt: null, revokedAt: null, lastUsedAt: null },
  ]);
  const links = await listConnectLinks("clinic-1", "http://ignored.test");
  assert.deepEqual(
    links.map((l) => [l.id, l.state, l.url]),
    [
      ["live", "active", `https://revos.example.test/connect/${token}`],
      ["old", "revoked", null],
      ["gone", "expired", null],
      ["lost-key", "active", null],
    ],
  );
  assert.equal(connectLinkUrl("t", "https://a.test"), "https://revos.example.test/connect/t");
});

test("rate limit: blocks past the max and resets after the window", () => {
  const limit = { max: 3, windowMs: 1000 };
  assert.deepEqual([1, 2, 3, 4].map(() => rateLimited("k", limit, 0)), [false, false, false, true]);
  assert.equal(rateLimited("other", limit, 0), false, "keys are separate");
  assert.equal(rateLimited("k", limit, 1001), false, "new window");
});

test("caller address comes from the first X-Forwarded-For entry", () => {
  const req = (h: Record<string, string>) => new Request("http://localhost/x", { headers: h });
  assert.equal(clientIp(req({ "x-forwarded-for": "203.0.113.7, 10.0.0.1" })), "203.0.113.7");
  assert.equal(clientIp(req({ "x-real-ip": "203.0.113.8" })), "203.0.113.8");
  assert.equal(clientIp(req({})), "unknown");
});

test("public guard: bad links get the expired message, live ones are rate limited and touched", async () => {
  const token = newConnectToken();
  const params = (t: unknown) => Promise.resolve({ token: t });
  const req = () => new Request("http://localhost/api/public/connect/x", { method: "POST", headers: { "x-forwarded-for": "203.0.113.9" } });

  const bad = await requireConnectLinkApi(req(), params({ $ne: "" }), "upload");
  assert.ok("error" in bad);
  assert.equal(bad.error.status, 400);

  mock.method(prisma.clinicConnectLink, "findUnique", async () => ({
    id: "link-1",
    clinicId: "clinic-1",
    expiresAt: null,
    revokedAt: new Date("2026-11-01"),
    clinic,
  }));
  const revoked = await requireConnectLinkApi(req(), params(token), "upload");
  assert.ok("error" in revoked);
  assert.equal(revoked.error.status, 404);
  assert.deepEqual(await revoked.error.json(), { error: EXPIRED_MESSAGE });

  mock.restoreAll();
  mock.method(prisma.clinicConnectLink, "findUnique", async () => ({
    id: "link-1",
    clinicId: "clinic-1",
    expiresAt: null,
    revokedAt: null,
    clinic,
  }));
  const touch = mock.method(prisma.clinicConnectLink, "update", async () => ({}));
  const ok = await requireConnectLinkApi(req(), params(token), "connect");
  assert.ok(!("error" in ok));
  assert.equal(ok.link.clinicId, "clinic-1");
  assert.equal(ok.ip, "203.0.113.9");
  assert.deepEqual((touch.mock.calls[0].arguments[0] as { where: unknown }).where, { id: "link-1" });

  // 20 connect attempts per link and address in 10 minutes (one used above).
  let last: Awaited<ReturnType<typeof requireConnectLinkApi>> = ok;
  for (let i = 0; i < 20; i++) last = await requireConnectLinkApi(req(), params(token), "connect");
  assert.ok("error" in last);
  assert.equal(last.error.status, 429);
});
