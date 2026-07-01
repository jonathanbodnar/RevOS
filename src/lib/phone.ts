/**
 * Phone-number normalization for matching across systems (InBody, LunarPay,
 * manual entry). We reduce any input to its significant digits and key on the
 * last 10 (US national number) so that formats like "+1 (555) 123-4567",
 * "5551234567", and "1-555-123-4567" all collapse to the same value.
 *
 * International numbers longer than 10 digits keep their last 10 significant
 * digits, which is good enough for the single-country deployment here. If we
 * ever go multi-country this should key on E.164 instead.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null;
  let digits = String(input).replace(/\D+/g, "");
  if (!digits) return null;
  // Drop a leading US country code if present (11 digits starting with 1).
  if (digits.length === 11 && digits.startsWith("1")) {
    digits = digits.slice(1);
  }
  // Key on the last 10 digits for stable cross-system matching.
  if (digits.length > 10) {
    digits = digits.slice(-10);
  }
  return digits;
}

/** Pretty US phone formatting for display; falls back to the raw input. */
export function formatPhone(input: string | null | undefined): string {
  const n = normalizePhone(input);
  if (n && n.length === 10) {
    return `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6)}`;
  }
  return input ? String(input) : "—";
}
