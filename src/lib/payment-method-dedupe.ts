/**
 * De-duplicating vaulted cards.
 *
 * LunarPay mints a NEW payment-method id every time a card is vaulted, even for
 * the identical card on the identical customer — it has no dedupe of its own,
 * and our `@unique` on lunarpayPaymentMethodId therefore never fires. So a
 * patient who saves a card via the update-card link and then types the same
 * card again at checkout silently ends up with two rows for one piece of
 * plastic, and their "default" card and the card backing their subscription can
 * drift apart.
 *
 * Scope, honestly stated: this collapses re-adds of the same card on the same
 * profile. It does NOT address duplicates created by merging two profiles —
 * at vault time those cards belonged to two different Customer rows, so no
 * per-customer lookup could have caught them.
 */
import { prisma } from "./prisma";

export type VaultedCard = {
  lunarpayPaymentMethodId: number;
  lunarpayCustomerId: number | null;
  sourceType: string;
  lastDigits: string | null;
  nameHolder: string | null;
  expMonth: string | null;
  expYear: string | null;
};

/**
 * Record a freshly vaulted card, reusing the existing row when it is the same
 * card. Same card = same customer + same last four + same type. Expiry is
 * deliberately NOT part of the identity: a renewed card keeps its number and
 * only moves the expiry, and that should update the row rather than add one.
 */
export async function upsertVaultedCard(opts: {
  customerId: string;
  card: VaultedCard;
  setDefault: boolean;
}): Promise<{ id: string; deduped: boolean }> {
  const { customerId, card, setDefault } = opts;

  // Same LunarPay id => the very same vault entry (webhook replay, retry).
  const byLpId = await prisma.paymentMethod.findUnique({
    where: { lunarpayPaymentMethodId: card.lunarpayPaymentMethodId },
  });

  const existing =
    byLpId ??
    (card.lastDigits
      ? await prisma.paymentMethod.findFirst({
          where: {
            customerId,
            lastDigits: card.lastDigits,
            sourceType: card.sourceType,
            isActive: true,
          },
          orderBy: { createdAt: "desc" },
        })
      : null);

  if (setDefault) {
    await prisma.paymentMethod.updateMany({
      where: { customerId, isDefault: true },
      data: { isDefault: false },
    });
  }

  if (existing) {
    const updated = await prisma.paymentMethod.update({
      where: { id: existing.id },
      data: {
        // Point at the newest vault entry — the older one may be superseded at
        // LunarPay, and charges must use the id that still works.
        lunarpayPaymentMethodId: card.lunarpayPaymentMethodId,
        lunarpayCustomerId: card.lunarpayCustomerId ?? existing.lunarpayCustomerId,
        nameHolder: card.nameHolder ?? existing.nameHolder,
        expMonth: card.expMonth ?? existing.expMonth,
        expYear: card.expYear ?? existing.expYear,
        isActive: true,
        ...(setDefault ? { isDefault: true } : {}),
      },
    });
    return { id: updated.id, deduped: true };
  }

  const created = await prisma.paymentMethod.create({
    data: {
      customerId,
      lunarpayPaymentMethodId: card.lunarpayPaymentMethodId,
      lunarpayCustomerId: card.lunarpayCustomerId,
      sourceType: card.sourceType,
      lastDigits: card.lastDigits,
      nameHolder: card.nameHolder,
      expMonth: card.expMonth,
      expYear: card.expYear,
      isDefault: setDefault,
    },
  });
  return { id: created.id, deduped: false };
}
