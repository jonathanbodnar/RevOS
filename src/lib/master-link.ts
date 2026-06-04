/**
 * Master (configurable) payment link constants.
 *
 * A master link is a single reusable global link where the payer chooses the
 * amounts at checkout instead of the admin baking them into the link:
 *   - a down payment amount (optionally split 50/50 with a second dated payment)
 *   - an optional fixed $250/month subscription starting on a chosen date
 *
 * The 3.9% + $0.39 processing fee is applied to every resulting payment (the
 * down payment, the split second payment, and each subscription cycle).
 */

// Fixed monthly subscription amount for master links ($250.00), pre-fee.
export const MASTER_SUBSCRIPTION_CENTS = 25000;

// Master subscriptions always bill monthly.
export const MASTER_SUBSCRIPTION_FREQUENCY = "monthly" as const;

// Default number of days until the first subscription charge.
export const MASTER_SUBSCRIPTION_DEFAULT_DAYS = 30;
