/**
 * RFC 6238 TOTP (SHA-1, 30-second step, 6 digits) — no dependency, so it works
 * with any authenticator app (Google Authenticator, 1Password, Authy…). Used
 * for optional super-admin MFA. Verified against RFC test vectors in totp.test.
 */
import crypto from "crypto";

const STEP = 30;
const DIGITS = 6;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Generate a random base32 secret (default 160 bits, per RFC recommendation). */
export function generateSecret(bytes = 20): string {
  const buf = crypto.randomBytes(bytes);
  let bits = "";
  for (const b of buf) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    out += B32[parseInt(bits.slice(i, i + 5), 2)];
  }
  return out;
}

/** Thrown when a stored "secret" isn't a usable base32 key — a config error. */
export class InvalidSecretError extends Error {
  constructor() {
    super("TOTP secret is not valid base32 — the stored secret is unusable.");
    this.name = "InvalidSecretError";
  }
}

/** True when `s` is a well-formed base32 TOTP secret of usable length. */
export function isValidSecret(s: string | null | undefined): boolean {
  if (!s) return false;
  const clean = s.replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  // ≥16 chars = ≥80 bits, the RFC 4226 minimum.
  return clean.length >= 16 && /^[A-Z2-7]+$/.test(clean);
}

function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  // Reject rather than skip invalid characters. Silently dropping them turned
  // any garbage string (a decryption-failure placeholder, raw ciphertext) into
  // a plausible-looking key that produced stable, always-wrong codes — which
  // then got reported to the user as "that code didn't match".
  if (!isValidSecret(clean)) throw new InvalidSecretError();
  let bits = "";
  for (const c of clean) {
    bits += B32.indexOf(c).toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function hotp(key: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter.
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return (bin % 10 ** DIGITS).toString().padStart(DIGITS, "0");
}

/** Current TOTP for a base32 secret. `time` in seconds (default now). */
export function totp(secret: string, time = Date.now() / 1000): string {
  return hotp(base32Decode(secret), Math.floor(time / STEP));
}

/**
 * Verify a code against a secret, tolerating ±`window` steps of clock drift.
 * Constant-time-ish comparison per candidate.
 *
 * Returns false for a wrong or malformed *code*; throws `InvalidSecretError`
 * for an unusable *secret*. Callers must keep those apart — one is a user
 * mistake, the other is a server misconfiguration.
 */
export function verifyTotp(
  secret: string,
  code: string,
  window = 1,
  time = Date.now() / 1000,
): boolean {
  const cleanCode = (code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(cleanCode)) return false;
  const key = base32Decode(secret);
  const counter = Math.floor(time / STEP);
  for (let w = -window; w <= window; w++) {
    const cand = hotp(key, counter + w);
    if (
      cand.length === cleanCode.length &&
      crypto.timingSafeEqual(Buffer.from(cand), Buffer.from(cleanCode))
    ) {
      return true;
    }
  }
  return false;
}

/** otpauth:// URI for QR enrollment. */
export function otpauthUri(secret: string, label: string, issuer = "RevOS"): string {
  const l = encodeURIComponent(`${issuer}:${label}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP),
  });
  return `otpauth://totp/${l}?${params.toString()}`;
}
