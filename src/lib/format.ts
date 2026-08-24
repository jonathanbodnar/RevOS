/**
 * "Card •••• 4242" / "Bank •••• 6789" for a charge's payment method.
 *
 * Reads `sourceType` off the PaymentMethod rather than `Charge.paymentMethodType`
 * — the latter is null on roughly a fifth of rows, while the former is always
 * populated on a linked card.
 */
export function formatCardLabel(
  pm: { sourceType: string; lastDigits: string | null } | null | undefined,
): string | null {
  if (!pm) return null;
  return `${pm.sourceType === "ach" ? "Bank" : "Card"} •••• ${pm.lastDigits ?? "????"}`;
}

export function formatMoneyCents(cents: number): string {
  const dollars = cents / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(dollars);
}

export function formatDate(input: Date | string | null | undefined): string {
  if (!input) return "—";
  const d = typeof input === "string" ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function parseMoneyInputToCents(input: string): number | null {
  const trimmed = input.trim().replace(/[$,]/g, "");
  if (!trimmed) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}
