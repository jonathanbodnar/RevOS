import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { encode, decode, getToken } from "next-auth/jwt";

test("encrypted sessions preserve roles and clinic impersonation after auth updates", async () => {
  const secret = randomBytes(32).toString("hex");
  const session = { uid: "admin", role: "SUPER_ADMIN" as const, clinicId: null, impersonatingClinicId: "clinic-1" };
  const token = await encode({ secret, token: session, maxAge: 8 * 60 * 60 });
  const restored = await decode({ secret, token });
  assert.ok(restored);
  for (const [key, value] of Object.entries(session)) assert.equal(restored[key], value);
  await assert.rejects(decode({ secret: randomBytes(32).toString("hex"), token }));
});

test("malformed bearer tokens fail closed without an uncaught URI error", async () => {
  const secret = randomBytes(32).toString("hex");
  for (const authorization of ["Bearer %", "Bearer %ZZ", "Bearer %E0%A4%A", "Bearer not-a-token"]) {
    const req = { headers: { authorization }, cookies: {} } as Parameters<typeof getToken>[0]["req"];
    assert.equal(await getToken({ req, secret }), null);
  }
});
