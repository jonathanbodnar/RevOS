import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import {
  encryptField,
  decryptField,
  decryptSecret,
  assertReadable,
  isDecryptFailure,
  DecryptionError,
  DECRYPT_FAILED,
} from "./encryption";

const KEY_A = crypto.randomBytes(32).toString("hex");
const KEY_B = crypto.randomBytes(32).toString("hex");

afterEach(() => {
  delete process.env.FIELD_ENCRYPTION_KEY;
  delete process.env.FIELD_ENCRYPTION_KEY_PREVIOUS;
});

test("round-trips under a single key", () => {
  process.env.FIELD_ENCRYPTION_KEY = KEY_A;
  const ct = encryptField("JBSWY3DPEHPK3PXP");
  assert.ok(ct?.startsWith("enc:v1:"));
  assert.equal(decryptField(ct), "JBSWY3DPEHPK3PXP");
});

test("a rotated-away key makes the value unreadable, not silently wrong", () => {
  process.env.FIELD_ENCRYPTION_KEY = KEY_A;
  const ct = encryptField("JBSWY3DPEHPK3PXP");
  // Rotate: primary is now B, and A was not retained.
  process.env.FIELD_ENCRYPTION_KEY = KEY_B;
  assert.equal(decryptField(ct), DECRYPT_FAILED);
  assert.ok(isDecryptFailure(decryptField(ct)));
});

test("FIELD_ENCRYPTION_KEY_PREVIOUS recovers values written under the old key", () => {
  process.env.FIELD_ENCRYPTION_KEY = KEY_A;
  const ct = encryptField("JBSWY3DPEHPK3PXP");
  process.env.FIELD_ENCRYPTION_KEY = KEY_B;
  process.env.FIELD_ENCRYPTION_KEY_PREVIOUS = KEY_A;
  assert.equal(decryptField(ct), "JBSWY3DPEHPK3PXP");
  // New writes use the primary key and still read back.
  assert.equal(decryptField(encryptField("second")), "second");
});

test("encrypted data with no key configured does not leak ciphertext", () => {
  process.env.FIELD_ENCRYPTION_KEY = KEY_A;
  const ct = encryptField("secret-note");
  delete process.env.FIELD_ENCRYPTION_KEY;
  // Previously returned the raw ciphertext, which flowed onward as "plaintext".
  assert.equal(decryptField(ct), DECRYPT_FAILED);
});

test("plaintext (unmarked) values pass through untouched", () => {
  process.env.FIELD_ENCRYPTION_KEY = KEY_A;
  assert.equal(decryptField("legacy plaintext"), "legacy plaintext");
  assert.equal(decryptField(null), null);
});

test("decryptSecret throws instead of yielding a placeholder", () => {
  process.env.FIELD_ENCRYPTION_KEY = KEY_A;
  const ct = encryptField("JBSWY3DPEHPK3PXP");
  process.env.FIELD_ENCRYPTION_KEY = KEY_B;
  assert.throws(() => decryptSecret(ct, "MFA secret"), DecryptionError);
  assert.equal(decryptSecret(null), null);
});

test("assertReadable blocks re-encrypting a failure placeholder", () => {
  assert.throws(() => assertReadable(DECRYPT_FAILED, "notes"), DecryptionError);
  assert.equal(assertReadable("real notes", "notes"), "real notes");
  assert.equal(assertReadable(null, "notes"), null);
});
