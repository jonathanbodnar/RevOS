import { Prisma, type Charge } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/** True for Prisma's unique-constraint violation (P2002). */
export function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}

/**
 * Record a charge that our own `lunarpay.createCharge()` call just made.
 *
 * LunarPay fires its `charge.succeeded` webhook without awaiting it, right
 * before it answers POST /charges, so the webhook handler can insert the same
 * `lunarpayChargeId` before the caller gets the response. A plain create then
 * fails the unique constraint AFTER the card was charged, which aborted
 * checkout before the subscription was started and told the payer to try
 * again. Our insert usually wins by ~200ms, so this only shows up sometimes.
 *
 * When the webhook got there first, its row stays authoritative for
 * settlement (status, amount, refunds, timestamp); we fill in what only the
 * caller knows — the link, card, customer, clinic and description. Nulls
 * never overwrite what the webhook recorded.
 *
 * Only for ids returned by our own LunarPay call. Never pass an id a client
 * supplied: on conflict this re-points the existing row.
 */
export async function recordLunarPayCharge(
  data: Prisma.ChargeUncheckedCreateInput,
): Promise<Charge> {
  try {
    return await prisma.charge.create({ data });
  } catch (e) {
    // Charge.id is a generated cuid, so a conflict can only be lunarpayChargeId.
    if (!isUniqueViolation(e)) throw e;
  }
  return prisma.charge.update({
    where: { lunarpayChargeId: data.lunarpayChargeId },
    data: {
      clinicId: data.clinicId ?? undefined,
      customerId: data.customerId,
      paymentMethodId: data.paymentMethodId ?? undefined,
      paymentLinkId: data.paymentLinkId ?? undefined,
      fortisTransactionId: data.fortisTransactionId ?? undefined,
      paymentMethodType: data.paymentMethodType ?? undefined,
      description: data.description ?? undefined,
    },
  });
}
