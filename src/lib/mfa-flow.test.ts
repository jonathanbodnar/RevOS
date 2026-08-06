/**
 * End-to-end MFA enrollment + login, exercising the exact sequence the routes
 * perform (POST /api/account/mfa -> PUT -> login) without a database.
 *
 * The point of this test is the key handling: nothing here is per-user config.
 * One app-wide FIELD_ENCRYPTION_KEY protects every user's secret, and enrolling
 * another user is just another row.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { encryptField, decryptSecret, DecryptionError } from "./encryption";
import { generateSecret, totp, verifyTotp, otpauthUri } from "./totp";

const KEY_A = crypto.randomBytes(32).toString("hex");
const KEY_B = crypto.randomBytes(32).toString("hex");

/** Minimal stand-in for the User row's MFA columns. */
type Row = { mfaSecret: string | null; mfaPendingSecret: string | null; mfaEnabled: boolean };

/** POST /api/account/mfa — generate a secret, store it pending, show it to the user. */
function startEnrollment(row: Row, email: string) {
  const secret = generateSecret();
  row.mfaPendingSecret = encryptField(secret);
  return { secret, uri: otpauthUri(secret, email) };
}

/** PUT /api/account/mfa — verify a code against the pending secret and go live. */
function finishEnrollment(row: Row, code: string): boolean {
  const pending = decryptSecret(row.mfaPendingSecret, "MFA secret");
  if (!pending || !verifyTotp(pending, code)) return false;
  row.mfaSecret = row.mfaPendingSecret;
  row.mfaEnabled = true;
  row.mfaPendingSecret = null;
  return true;
}

/** src/lib/auth.ts — the login-time second-factor gate. */
function loginGate(row: Row, code: string): boolean {
  if (!(row.mfaEnabled && row.mfaSecret)) return true; // no factor -> password only
  const secret = decryptSecret(row.mfaSecret, "MFA secret");
  return !!secret && verifyTotp(secret, code);
}

function blank(): Row {
  return { mfaSecret: null, mfaPendingSecret: null, mfaEnabled: false };
}

test("a user enrolls and then logs in with a code from their app", () => {
  process.env.FIELD_ENCRYPTION_KEY = KEY_A;
  const row = blank();

  const { secret, uri } = startEnrollment(row, "admin@revos.local");
  assert.match(uri, /^otpauth:\/\/totp\//);
  assert.match(uri, /digits=6/);
  assert.match(uri, /period=30/);
  assert.equal(row.mfaEnabled, false, "enrollment must not go live before verification");

  // The authenticator app computes this from the scanned secret.
  assert.equal(finishEnrollment(row, totp(secret)), true);
  assert.equal(row.mfaEnabled, true);

  assert.equal(loginGate(row, totp(secret)), true, "correct code logs in");
  assert.equal(loginGate(row, "000000"), false, "wrong code does not");

  delete process.env.FIELD_ENCRYPTION_KEY;
});

test("many users enroll under ONE app-wide key — nothing is per-user config", () => {
  process.env.FIELD_ENCRYPTION_KEY = KEY_A;

  const users = ["admin@revos.local", "a@clinic.test", "b@clinic.test", "c@clinic.test"];
  const rows = users.map((email) => {
    const row = blank();
    const { secret } = startEnrollment(row, email);
    assert.equal(finishEnrollment(row, totp(secret)), true);
    return { row, secret };
  });

  // Every user has a DISTINCT secret...
  assert.equal(new Set(rows.map((r) => r.secret)).size, users.length);
  // ...all readable under the same single key, with no extra configuration.
  for (const { row, secret } of rows) {
    assert.equal(loginGate(row, totp(secret)), true);
  }
  // And one user's code never works for another.
  assert.equal(loginGate(rows[0].row, totp(rows[1].secret)), false);

  delete process.env.FIELD_ENCRYPTION_KEY;
});

test("rotating the key without retaining the old one locks the user out", () => {
  process.env.FIELD_ENCRYPTION_KEY = KEY_A;
  const row = blank();
  const { secret } = startEnrollment(row, "admin@revos.local");
  finishEnrollment(row, totp(secret));

  // This is exactly what happened in production on 2026-08-05.
  process.env.FIELD_ENCRYPTION_KEY = KEY_B;
  assert.throws(() => loginGate(row, totp(secret)), DecryptionError,
    "a correct code must fail LOUDLY as a key problem, not silently as a bad code");

  // Retaining the old key restores access — no re-enrollment, same authenticator.
  process.env.FIELD_ENCRYPTION_KEY_PREVIOUS = KEY_A;
  assert.equal(loginGate(row, totp(secret)), true);

  delete process.env.FIELD_ENCRYPTION_KEY;
  delete process.env.FIELD_ENCRYPTION_KEY_PREVIOUS;
});
