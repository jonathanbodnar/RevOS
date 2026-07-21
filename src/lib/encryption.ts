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
 * SCOPE: applied to non-indexed free-text PHI (clinical notes, raw InBody
 * payloads). Encrypting indexed identifiers (email/phone) needs a searchable-
 * encryption scheme and is a separate, dedicated migration (see the roadmap's
 * HIPAA-infrastructure phase).
 */
import crypto from "crypto";

const MARKER = "enc:v1:";

function getKey(): Buffer | null {
  const raw = process.env.FIELD_ENCRYPTION_KEY;
  if (!raw) return null;
  const buf =
    /^[0-9a-fA-F]{64}$/.test(raw)
      ? Buffer.from(raw, "hex")
      : Buffer.from(raw, "base64");
  return buf.length === 32 ? buf : null;
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

/** Decrypt a stored value. Returns marked ciphertext decrypted; plaintext as-is. */
export function decryptField(stored: string | null | undefined): string | null {
  if (stored == null) return null;
  if (!stored.startsWith(MARKER)) return stored; // legacy plaintext
  const key = getKey();
  if (!key) return stored; // can't decrypt without the key; surface raw
  try {
    const buf = Buffer.from(stored.slice(MARKER.length), "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    return "[unable to decrypt]";
  }
}
