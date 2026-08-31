/**
 * Processing fee applied to every transaction: 3.9% + $0.39 flat.
 *
 * This fee is added on top of the clinic-configured base amount and passed
 * through to Fortis / LunarPay so the customer bears the cost.
 *
 * Used everywhere a payment is collected:
 *   - Payment link one-time charges (transaction intention)
 *   - Payment link setup fees (combined / ticket intention)
 *   - Recurring subscriptions (each billing cycle)
 *   - Installment payments (each scheduled payment)
 *   - Manual charges from the clinic portal
 *   - Manual subscriptions from the clinic portal
 */

export const FEE_PERCENT = 0.039;
export const FEE_FLAT_CENTS = 39; // $0.39

/**
 * Returns the processing fee and total for a given base amount.
 *
 * feeCents = round(base * 3.9%) + 39¢
 * totalCents = base + feeCents
 */
export function calcFee(baseCents: number): {
  baseCents: number;
  feeCents: number;
  totalCents: number;
} {
  const feeCents = Math.round(baseCents * FEE_PERCENT) + FEE_FLAT_CENTS;
  return { baseCents, feeCents, totalCents: baseCents + feeCents };
}

/**
 * Recover the base amount from a fee-inclusive total — the inverse of calcFee.
 *
 * Stored amounts (Subscription.amountCents, Charge.amountCents) are totals with
 * the fee already added. Anything that re-creates a payment from a stored amount
 * must invert the fee first, or calcFee runs twice and the customer is quietly
 * billed the fee on the fee (a $260.14 plan comes back as $270.68).
 *
 * Returns null when the value doesn't round-trip, so a caller can refuse rather
 * than guess: rounding means not every total is reachable from some base.
 */
export function baseCentsFromTotal(totalCents: number): number | null {
  const estimate = Math.round((totalCents - FEE_FLAT_CENTS) / (1 + FEE_PERCENT));
  // Rounding in calcFee means the estimate can land a cent either side.
  for (const base of [estimate, estimate - 1, estimate + 1]) {
    if (base > 0 && calcFee(base).totalCents === totalCents) return base;
  }
  return null;
}

/**
 * Formatted fee description for display (e.g. "3.9% + $0.39").
 */
export const FEE_LABEL = "3.9% + $0.39";
