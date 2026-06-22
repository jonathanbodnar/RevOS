import crypto from "crypto";
import { prisma } from "@/lib/prisma";

/**
 * Persist a FAILED payment attempt as a Charge row so declines show up in the
 * clinic dashboard, super-admin overview and reports.
 *
 * A declined attempt has no LunarPay charge id (the API call threw), so we mint
 * a synthetic `failed:<uuid>` id to satisfy the unique constraint. The decline
 * reason is stored in the description. Revenue aggregates everywhere scope to
 * status in (paid, pending, refunded), so these rows never inflate revenue.
 *
 * Never throws — recording a failure must not break the calling flow.
 */
export async function recordFailedCharge(opts: {
  clinicId: string | null;
  customerId: string;
  paymentMethodId?: string | null;
  amountCents: number;
  reason: string;
  paymentLinkId?: string | null;
  paymentMethodType?: string | null;
  description?: string | null;
  // When provided, the row gets a stable `failed:<externalId>` id and is
  // skipped if one already exists (idempotent webhook retries).
  externalId?: string | null;
}): Promise<void> {
  try {
    const desc = [opts.description, `Failed: ${opts.reason}`]
      .filter(Boolean)
      .join(" — ")
      .slice(0, 500);
    const lunarpayChargeId = opts.externalId
      ? `failed:${opts.externalId}`
      : `failed:${crypto.randomUUID()}`;

    if (opts.externalId) {
      const existing = await prisma.charge.findUnique({
        where: { lunarpayChargeId },
      });
      if (existing) return;
    }

    await prisma.charge.create({
      data: {
        clinicId: opts.clinicId,
        customerId: opts.customerId,
        paymentMethodId: opts.paymentMethodId ?? null,
        paymentLinkId: opts.paymentLinkId ?? null,
        lunarpayChargeId,
        amountCents: Math.max(0, Math.round(opts.amountCents)),
        status: "failed",
        paymentMethodType: opts.paymentMethodType ?? null,
        description: desc,
      },
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[recordFailedCharge] could not persist failed charge", e);
  }
}
