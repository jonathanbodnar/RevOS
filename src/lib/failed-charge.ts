import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { formatMoneyCents } from "@/lib/format";
import { notifyFailedPayment } from "@/lib/notify";

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

    const amountCents = Math.max(0, Math.round(opts.amountCents));
    await prisma.charge.create({
      data: {
        clinicId: opts.clinicId,
        customerId: opts.customerId,
        paymentMethodId: opts.paymentMethodId ?? null,
        paymentLinkId: opts.paymentLinkId ?? null,
        lunarpayChargeId,
        amountCents,
        status: "failed",
        paymentMethodType: opts.paymentMethodType ?? null,
        description: desc,
      },
    });

    // Outbound alert (Zapier, etc.) — only when a new failure was recorded.
    const [customer, clinic] = await Promise.all([
      prisma.customer.findUnique({
        where: { id: opts.customerId },
        select: { id: true, firstName: true, lastName: true, email: true, phone: true },
      }),
      opts.clinicId
        ? prisma.clinic.findUnique({
            where: { id: opts.clinicId },
            select: { id: true, name: true },
          })
        : Promise.resolve(null),
    ]);

    if (customer) {
      const name =
        [customer.firstName, customer.lastName].filter(Boolean).join(" ") ||
        customer.email ||
        "Customer";
      await notifyFailedPayment({
        customer: {
          id: customer.id,
          name,
          email: customer.email,
          phone: customer.phone,
        },
        clinic: { id: clinic?.id ?? opts.clinicId ?? null, name: clinic?.name ?? null },
        amountCents,
        amount: formatMoneyCents(amountCents),
        error: opts.reason,
        description: opts.description ?? null,
        source: opts.description ?? "Payment",
      });
    }
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[recordFailedCharge] could not persist failed charge", e);
  }
}
