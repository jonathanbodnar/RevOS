/**
 * LunarPay webhook handler.
 *
 * Handles the checkout.session.completed event to:
 *  1. Mark the CheckoutSession as completed
 *  2. Ensure the customer has a LunarPay customer ID
 *  3. Upsert the PaymentMethod in our DB
 *  4. Record the Charge
 *  5. If mode="subscription": record the Subscription
 *
 * Signature verification is performed when LUNARPAY_WEBHOOK_SECRET is set.
 * LunarPay expects a 200 on success; we always return 200 for processing
 * errors to prevent runaway retries, and log the failure internally.
 */

import { NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { recordFailedCharge } from "@/lib/failed-charge";

// ---------- Webhook payload types ----------

type WebhookPaymentMethod = {
  id: number;
  type: "cc" | "ach";
  last4?: string;
};

type WebhookTransaction = {
  id: string;
  fortis_transaction_id?: string;
  amount: number;
  payment_method: "cc" | "ach";
};

type WebhookCustomer = {
  id: number;
  email?: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
};

type WebhookSession = {
  id: number;
  token: string;
  amount: number;
  description?: string;
  mode?: string;
  paid_at?: string;
};

type WebhookResources = {
  subscription_id?: number | null;
  payment_schedule_id?: number | null;
};

type CheckoutSessionCompletedPayload = {
  event: "checkout.session.completed";
  session: WebhookSession;
  transaction: WebhookTransaction;
  customer: WebhookCustomer;
  payment_method: WebhookPaymentMethod;
  resources?: WebhookResources;
};

// ---------- Helpers ----------

function computeNextPaymentOn(frequency: string): Date {
  const d = new Date();
  switch (frequency) {
    case "weekly":
      d.setDate(d.getDate() + 7);
      break;
    case "quarterly":
      d.setMonth(d.getMonth() + 3);
      break;
    case "yearly":
      d.setFullYear(d.getFullYear() + 1);
      break;
    default: // monthly
      d.setMonth(d.getMonth() + 1);
  }
  return d;
}

// ---------- Route ----------

export async function POST(req: Request) {
  const rawBody = await req.text();
  const sig = req.headers.get("x-lunarpay-signature");
  const secret = process.env.LUNARPAY_WEBHOOK_SECRET;

  // Verify signature when secret is configured
  if (secret) {
    const expected = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");
    if (expected !== sig) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const event = typeof payload.event === "string" ? payload.event : "";

  try {
    if (event === "checkout.session.completed") {
      await handleSessionCompleted(payload as unknown as CheckoutSessionCompletedPayload);
    } else if (isFailureEvent(event)) {
      // Recurring subscription / installment / one-off declines. LunarPay's
      // exact event names aren't documented to us, so we match any event whose
      // name signals a failure and record it best-effort.
      await handleFailedPayment(event, payload);
    } else {
      // Surface unknown events in logs so we can wire them up precisely later.
      console.info(`[webhook/lunarpay] unhandled event: ${event || "(none)"}`);
    }
  } catch (err) {
    console.error("[webhook/lunarpay] Unhandled error:", err);
    // Return 200 anyway to prevent LunarPay from retrying indefinitely
  }

  return NextResponse.json({ ok: true });
}

function isFailureEvent(event: string): boolean {
  const e = event.toLowerCase();
  return (
    e.includes("fail") ||
    e.includes("declin") ||
    e.endsWith(".error") ||
    e.includes("payment_failed")
  );
}

/** Defensive deep getter for the assorted shapes LunarPay may send. */
function pick(obj: unknown, paths: string[]): unknown {
  for (const path of paths) {
    let cur: unknown = obj;
    let ok = true;
    for (const key of path.split(".")) {
      if (cur && typeof cur === "object" && key in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[key];
      } else {
        ok = false;
        break;
      }
    }
    if (ok && cur != null) return cur;
  }
  return undefined;
}

function toCents(amount: unknown): number {
  if (typeof amount === "number" && Number.isFinite(amount)) {
    // LunarPay amounts are dollars; integers > 1000 are almost certainly cents
    // already. Treat sub-10000 numbers with decimals as dollars.
    return Number.isInteger(amount) && amount < 100000
      ? Math.round(amount * 100)
      : Math.round(amount);
  }
  if (typeof amount === "string") {
    const n = parseFloat(amount);
    if (Number.isFinite(n)) return Math.round(n * 100);
  }
  return 0;
}

/**
 * Record a failed recurring / installment / one-off payment from a webhook.
 * Maps the event to one of our customers via the LunarPay customer id, the
 * subscription id, the schedule id, or a session token — whichever is present.
 */
async function handleFailedPayment(event: string, payload: Record<string, unknown>) {
  const lpCustomerId = Number(
    pick(payload, [
      "customer.id",
      "customer_id",
      "transaction.customer_id",
      "subscription.customer_id",
      "payment_schedule.customer_id",
    ]) ?? NaN,
  );
  const subId = Number(
    pick(payload, ["subscription.id", "subscription_id", "resources.subscription_id"]) ?? NaN,
  );
  const scheduleId = Number(
    pick(payload, ["payment_schedule.id", "payment_schedule_id", "resources.payment_schedule_id"]) ?? NaN,
  );
  const token = pick(payload, ["session.token", "token"]);

  let customer = null;
  if (Number.isFinite(lpCustomerId)) {
    customer = await prisma.customer.findFirst({
      where: { lunarpayCustomerId: lpCustomerId },
    });
  }
  let paymentMethodId: string | null = null;
  let clinicId: string | null = customer?.clinicId ?? null;

  if (!customer && Number.isFinite(subId)) {
    const sub = await prisma.subscription.findUnique({
      where: { lunarpaySubscriptionId: subId },
    });
    if (sub) {
      customer = await prisma.customer.findUnique({ where: { id: sub.customerId } });
      paymentMethodId = sub.paymentMethodId;
      clinicId = sub.clinicId;
    }
  }
  if (!customer && Number.isFinite(scheduleId)) {
    const sch = await prisma.paymentSchedule.findUnique({
      where: { lunarpayScheduleId: scheduleId },
    });
    if (sch) {
      customer = await prisma.customer.findUnique({ where: { id: sch.customerId } });
      paymentMethodId = sch.paymentMethodId;
      clinicId = sch.clinicId;
    }
  }
  if (!customer && typeof token === "string") {
    const cs = await prisma.checkoutSession.findUnique({ where: { token } });
    if (cs?.customerId) {
      customer = await prisma.customer.findUnique({ where: { id: cs.customerId } });
      clinicId = cs.clinicId;
    }
  }

  if (!customer) {
    console.warn(`[webhook/lunarpay] failure event ${event} could not be mapped to a customer`, {
      lpCustomerId,
      subId,
      scheduleId,
    });
    return;
  }

  const amountCents = toCents(
    pick(payload, ["transaction.amount", "amount", "payment.amount", "subscription.amount"]),
  );
  const reason =
    (pick(payload, [
      "transaction.decline_reason",
      "error.message",
      "message",
      "reason",
      "transaction.status",
    ]) as string | undefined) ?? event;
  const txId = pick(payload, ["transaction.id", "id", "payment.id"]);
  const kind = Number.isFinite(subId)
    ? "Subscription renewal"
    : Number.isFinite(scheduleId)
      ? "Installment payment"
      : "Payment";

  await recordFailedCharge({
    clinicId,
    customerId: customer.id,
    paymentMethodId,
    amountCents,
    reason: String(reason).slice(0, 200),
    description: `${kind} (auto)`,
    externalId: txId != null ? String(txId) : `${event}:${subId || scheduleId || customer.id}:${Date.now()}`,
  });

  await logAudit({
    actorId: null,
    actorRole: "WEBHOOK",
    clinicId,
    action: "charge.failed.webhook",
    targetType: "Customer",
    targetId: customer.id,
    metadata: { event, amountCents, subId, scheduleId },
  });
}

async function handleSessionCompleted(p: CheckoutSessionCompletedPayload) {
  const { session, transaction, customer: lpCustomer, payment_method, resources } = p;

  // 1. Find our CheckoutSession by token
  const cs = await prisma.checkoutSession.findUnique({
    where: { token: session.token },
  });
  if (!cs) {
    console.warn(`[webhook] CheckoutSession not found for token ${session.token}`);
    return;
  }

  // Idempotency: already processed
  if (cs.status === "completed") return;

  // 2. Find or create our Customer record
  let customer = cs.customerId
    ? await prisma.customer.findUnique({ where: { id: cs.customerId } })
    : null;

  if (!customer) {
    // Try matching by LunarPay customer ID first
    customer = await prisma.customer.findFirst({
      where: { lunarpayCustomerId: lpCustomer.id },
    });
  }

  if (!customer && lpCustomer.email) {
    // Try matching by email within this clinic
    customer = await prisma.customer.findFirst({
      where: { clinicId: cs.clinicId, email: lpCustomer.email },
    });
  }

  if (!customer) {
    // Auto-create the customer for this clinic from the LunarPay data
    customer = await prisma.customer.create({
      data: {
        clinicId: cs.clinicId,
        lunarpayCustomerId: lpCustomer.id,
        email: lpCustomer.email ?? null,
        firstName: lpCustomer.first_name ?? null,
        lastName: lpCustomer.last_name ?? null,
        phone: lpCustomer.phone ?? null,
      },
    });

    await logAudit({
      actorId: null,
      actorRole: "WEBHOOK",
      clinicId: cs.clinicId,
      action: "customer.create.webhook",
      targetType: "Customer",
      targetId: customer.id,
      metadata: { lunarpayCustomerId: lpCustomer.id, email: lpCustomer.email },
    });

    // Link the session to the newly created customer
    await prisma.checkoutSession.update({
      where: { id: cs.id },
      data: { customerId: customer.id },
    });
  }

  // 3. Ensure the customer has a LunarPay customer ID
  if (!customer.lunarpayCustomerId) {
    customer = await prisma.customer.update({
      where: { id: customer.id },
      data: { lunarpayCustomerId: lpCustomer.id },
    });
  }

  // 4. Upsert the PaymentMethod
  let pm = await prisma.paymentMethod.findUnique({
    where: { lunarpayPaymentMethodId: payment_method.id },
  });

  if (!pm) {
    const existingCount = await prisma.paymentMethod.count({
      where: { customerId: customer.id, isActive: true },
    });
    const isFirst = existingCount === 0;

    if (isFirst) {
      await prisma.paymentMethod.updateMany({
        where: { customerId: customer.id, isDefault: true },
        data: { isDefault: false },
      });
    }

    pm = await prisma.paymentMethod.create({
      data: {
        customerId: customer.id,
        lunarpayPaymentMethodId: payment_method.id,
        lunarpayCustomerId: customer.lunarpayCustomerId,
        sourceType: payment_method.type,
        lastDigits: payment_method.last4 ?? null,
        isDefault: isFirst,
        isActive: true,
      },
    });

    await logAudit({
      actorId: null,
      actorRole: "WEBHOOK",
      clinicId: cs.clinicId,
      action: "payment_method.create.webhook",
      targetType: "Customer",
      targetId: customer.id,
      metadata: { lunarpayPaymentMethodId: payment_method.id },
    });
  }

  // 5. Record the Charge (idempotent)
  const chargeExists = await prisma.charge.findUnique({
    where: { lunarpayChargeId: transaction.id },
  });

  if (!chargeExists) {
    await prisma.charge.create({
      data: {
        clinicId: cs.clinicId,
        customerId: customer.id,
        paymentMethodId: pm.id,
        lunarpayChargeId: transaction.id,
        fortisTransactionId: transaction.fortis_transaction_id ?? null,
        amountCents: Math.round(transaction.amount * 100),
        status: transaction.payment_method === "ach" ? "pending" : "paid",
        paymentMethodType: transaction.payment_method,
        description: cs.description ?? null,
      },
    });

    await logAudit({
      actorId: null,
      actorRole: "WEBHOOK",
      clinicId: cs.clinicId,
      action: "charge.create.webhook",
      targetType: "Charge",
      targetId: transaction.id,
      metadata: { amountCents: Math.round(transaction.amount * 100) },
    });
  }

  // 6. Record Subscription if mode=subscription (idempotent)
  if (cs.mode === "subscription" && resources?.subscription_id) {
    const subExists = await prisma.subscription.findUnique({
      where: { lunarpaySubscriptionId: resources.subscription_id },
    });

    if (!subExists) {
      const meta = cs.metadataJson ? safeParseJson(cs.metadataJson) : {};
      const frequency = (meta as Record<string, string>).frequency ?? "monthly";
      const nextPaymentOn = computeNextPaymentOn(frequency);

      await prisma.subscription.create({
        data: {
          clinicId: cs.clinicId,
          customerId: customer.id,
          paymentMethodId: pm.id,
          lunarpaySubscriptionId: resources.subscription_id,
          amountCents: cs.amountCents,
          frequency,
          status: "active",
          nextPaymentOn,
          description: cs.description ?? null,
        },
      });

      await logAudit({
        actorId: null,
        actorRole: "WEBHOOK",
        clinicId: cs.clinicId,
        action: "subscription.create.webhook",
        targetType: "Subscription",
        targetId: String(resources.subscription_id),
        metadata: { frequency, amountCents: cs.amountCents },
      });
    }
  }

  // 7. Mark the CheckoutSession as completed
  await prisma.checkoutSession.update({
    where: { id: cs.id },
    data: {
      status: "completed",
      completedAt: session.paid_at ? new Date(session.paid_at) : new Date(),
    },
  });
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
