/**
 * Outbound notifications (e.g. Zapier) for operational events.
 *
 * Fire-and-forget with a short timeout so a slow/down receiver never blocks or
 * breaks the payment flow. The destination is configured via
 * FAILED_PAYMENT_WEBHOOK_URL; if unset, notifications are skipped.
 */

export type FailedPaymentNotification = {
  customer: {
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
  };
  clinic: { id: string | null; name: string | null };
  amountCents: number;
  amount: string;
  error: string;
  description: string | null;
  source: string;
};

export async function notifyFailedPayment(
  payload: FailedPaymentNotification,
): Promise<void> {
  const url = process.env.FAILED_PAYMENT_WEBHOOK_URL;
  if (!url) return;

  // The receiver (e.g. Zapier) is generally NOT HIPAA-eligible, so no PHI
  // leaves by default: we send ids + a deep link to the patient's RevOS
  // profile so staff can act, but not name/email/phone. Set
  // FAILED_PAYMENT_WEBHOOK_INCLUDE_PII=true ONLY if the receiver is covered by
  // a BAA.
  const includePii = process.env.FAILED_PAYMENT_WEBHOOK_INCLUDE_PII === "true";
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "";
  const profileUrl = appUrl
    ? `${appUrl.replace(/\/$/, "")}/clinic/customers/${payload.customer.id}`
    : null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "payment.failed",
        timestamp: new Date().toISOString(),
        customer_id: payload.customer.id,
        customer_profile_url: profileUrl,
        clinic_id: payload.clinic.id,
        clinic_name: payload.clinic.name,
        amount_cents: payload.amountCents,
        amount: payload.amount,
        error: payload.error,
        description: payload.description,
        source: payload.source,
        ...(includePii
          ? {
              customer_name: payload.customer.name,
              customer_email: payload.customer.email,
              customer_phone: payload.customer.phone,
            }
          : {}),
      }),
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[notifyFailedPayment] delivery failed", e);
  } finally {
    clearTimeout(timeout);
  }
}
