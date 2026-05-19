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
 * Formatted fee description for display (e.g. "3.9% + $0.39").
 */
export const FEE_LABEL = "3.9% + $0.39";
