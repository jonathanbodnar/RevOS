/**
 * Field-level encryption for free-text PHI (AES-256-GCM).
 *
 * Design goals:
 *  - Transparent: `encryptField`/`decryptField` are safe to wrap around any
 *    read/write. When FIELD_ENCRYPTION_KEY is unset (e.g. local dev), they are
 *    a no-op passthrough, so nothing breaks.
 *  - Backward-compatible: ciphertext carries an "enc:v1:" marker. `decryptField`
 *    only decrypts marked values and returns legacy plaintext unchanged, so a
 *    column can be migrated lazily (new writes encrypted, old rows still read).
 *
 * KEY: FIELD_ENCRYPTION_KEY must be 32 bytes, hex- or base64-encoded. Generate:
 *   openssl rand -hex 32
 *
 * ROTATION: set FIELD_ENCRYPTION_KEY_PREVIOUS (comma-separated, same encoding)
 * to the key(s) you rotated away from. Writes always use the primary key;
 * reads try the primary first, then each previous key. Without this, rotating
 * silently orphans every row written under the old key — the value still looks
 * like valid ciphertext but no longer authenticates.
 *
 * SCOPE: applied to non-indexed free-text PHI (clinical notes, raw InBody
 * payloads). Encrypting indexed identifiers (email/phone) needs a searchable-
 * encryption scheme and is a separate, dedicated migration (see the roadmap's
 * HIPAA-infrastructure phase).
 */
import crypto from "crypto";

const MARKER = "enc:v1:";

/**
 * Placeholder returned by `decryptField` when a marked value cannot be read
 * with any configured key. It is deliberately NOT a valid decryption result:
 * callers that need real plaintext must use `decryptSecret`, and display
 * callers can test it with `isDecryptFailure`.
 */
export const DECRYPT_FAILED = "[unable to decrypt]";

/** True when `decryptField` could not recover the plaintext. */
export function isDecryptFailure(value: string | null | undefined): boolean {
  return value === DECRYPT_FAILED;
}

/** Thrown when a value that MUST be readable (a secret) cannot be decrypted. */
export class DecryptionError extends Error {
  constructor(field: string) {
    super(
      `Cannot decrypt ${field}: it was encrypted with a key that is no longer ` +
        `configured. Restore the original FIELD_ENCRYPTION_KEY, or add it to ` +
        `FIELD_ENCRYPTION_KEY_PREVIOUS.`,
    );
    this.name = "DecryptionError";
  }
}

function parseKey(raw: string, varName: string): Buffer {
  const trimmed = raw.trim();
  const buf =
    /^[0-9a-fA-F]{64}$/.test(trimmed)
      ? Buffer.from(trimmed, "hex")
      : Buffer.from(trimmed, "base64");
  // A configured-but-malformed key must FAIL LOUD, not silently store
  // plaintext (fail-open). Only an ABSENT key means "encryption off".
  if (buf.length !== 32) {
    throw new Error(
      `${varName} must decode to 32 bytes (hex or base64). Refusing to store PHI unencrypted.`,
    );
  }
  return buf;
}

function getKey(): Buffer | null {
  const raw = process.env.FIELD_ENCRYPTION_KEY;
  if (!raw) return null; // encryption disabled — passthrough
  return parseKey(raw, "FIELD_ENCRYPTION_KEY");
}

/** Keys to try when reading: the primary, then any rotated-away predecessors. */
function getDecryptKeys(): Buffer[] {
  const primary = getKey();
  if (!primary) return [];
  const previous = (process.env.FIELD_ENCRYPTION_KEY_PREVIOUS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => parseKey(k, "FIELD_ENCRYPTION_KEY_PREVIOUS"));
  return [primary, ...previous];
}

/** Encrypt a value for storage. No-op when no key is configured. */
export function encryptField(plain: string | null | undefined): string | null {
  if (plain == null || plain === "") return plain ?? null;
  const key = getKey();
  if (!key) return plain; // passthrough — plaintext, migrate later
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return (
    MARKER + Buffer.concat([iv, tag, ct]).toString("base64")
  );
}

/**
 * Decrypt a stored value. Returns marked ciphertext decrypted, plaintext as-is,
 * and `DECRYPT_FAILED` when no configured key can read it.
 *
 * NOTE: an unreadable value yields `DECRYPT_FAILED`, never the raw ciphertext —
 * returning the ciphertext used to let an unreadable secret flow onward as if
 * it were plaintext, turning a key misconfiguration into a mystery "wrong
 * value" failure downstream. Use `decryptSecret` wherever the plaintext is
 * required for a security decision.
 */
export function decryptField(stored: string | null | undefined): string | null {
  if (stored == null) return null;
  if (!stored.startsWith(MARKER)) return stored; // legacy plaintext
  const keys = getDecryptKeys();
  if (!keys.length) return DECRYPT_FAILED; // encrypted data, but no key configured
  const buf = Buffer.from(stored.slice(MARKER.length), "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  for (const key of keys) {
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    } catch {
      // Wrong key (GCM tag mismatch) — try the next one.
    }
  }
  return DECRYPT_FAILED;
}

/**
 * Guard for decrypt → edit → re-encrypt round trips. Re-encrypting a failure
 * placeholder would overwrite the real ciphertext with the literal text
 * "[unable to decrypt]", destroying data that is still recoverable if the
 * original key is found. Call this before writing anything back.
 */
export function assertReadable(
  value: string | null,
  field = "value",
): string | null {
  if (isDecryptFailure(value)) throw new DecryptionError(field);
  return value;
}

/**
 * Decrypt a value whose plaintext is required to make a security decision
 * (e.g. a TOTP secret). Throws `DecryptionError` rather than returning a
 * placeholder, so a key problem can never be mistaken for a bad credential.
 */
export function decryptSecret(
  stored: string | null | undefined,
  field = "value",
): string | null {
  if (stored == null) return null;
  const out = decryptField(stored);
  if (out == null || isDecryptFailure(out)) throw new DecryptionError(field);
  return out;
}
