import { test } from "node:test";
import assert from "node:assert/strict";
import { totp, verifyTotp, isValidSecret, InvalidSecretError } from "./totp";

// RFC 6238 test vector: ASCII secret "12345678901234567890" is base32
// "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ". At T=59s the SHA-1 TOTP (8-digit) is
// 94287082, so the 6-digit truncation is 287082.
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("TOTP matches the RFC 6238 SHA-1 vector at T=59", () => {
  assert.equal(totp(SECRET, 59), "287082");
});

test("TOTP matches the RFC 6238 vector at T=1111111109", () => {
  // 8-digit is 07081804 → 6-digit truncation 081804.
  assert.equal(totp(SECRET, 1111111109), "081804");
});

test("verifyTotp accepts the correct current code", () => {
  assert.equal(verifyTotp(SECRET, "287082", 1, 59), true);
});

test("verifyTotp tolerates one step of drift", () => {
  const prev = totp(SECRET, 59 - 30);
  assert.equal(verifyTotp(SECRET, prev, 1, 59), true);
});

test("verifyTotp rejects a wrong code and malformed input", () => {
  assert.equal(verifyTotp(SECRET, "000000", 1, 59), false);
  assert.equal(verifyTotp(SECRET, "abc", 1, 59), false);
  assert.equal(verifyTotp(SECRET, "", 1, 59), false);
});

test("a non-base32 secret throws instead of yielding stable wrong codes", () => {
  // Regression: base32Decode used to skip invalid characters, so the
  // decryption-failure placeholder salvaged a 9-byte key and produced codes
  // that never matched — surfaced to the user as "that code didn't match".
  assert.throws(() => verifyTotp("[unable to decrypt]", "123456"), InvalidSecretError);
  assert.throws(() => totp("[unable to decrypt]", 59), InvalidSecretError);
  assert.throws(() => verifyTotp("enc:v1:AAAA", "123456"), InvalidSecretError);
});

test("isValidSecret accepts real secrets and rejects junk", () => {
  assert.equal(isValidSecret(SECRET), true);
  assert.equal(isValidSecret("[unable to decrypt]"), false);
  assert.equal(isValidSecret("SHORT"), false); // under the 80-bit minimum
  assert.equal(isValidSecret(""), false);
  assert.equal(isValidSecret(null), false);
});
