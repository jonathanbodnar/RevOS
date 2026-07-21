/**
 * LunarPay webhook handler.
 *
 * LunarPay signs every delivery:
 *   X-LunarPay-Signature: sha256=<hex>
 *   X-LunarPay-Event:     payment.failed
 *   X-LunarPay-Timestamp: 2026-06-22T16:17:00.000Z
 * where <hex> = HMAC-SHA256(`${timestamp}.${rawBody}`, webhook secret).
 *
 * Events handled:
 *   payment.succeeded       — subscription cron / installment charge succeeded
 *   payment.failed          — subscription cron / installment charge declined
 *   charge.succeeded        — POST /api/v1/charges succeeded
 *   charge.failed           — POST /api/v1/charges declined
 *   subscription.cancelled  — auto-cancelled after consecutive failures
 *   checkout.session.completed — legacy hosted-checkout completion (kept for
 *                                backward compatibility)
 *
 * Deliveries are fire-and-forget on the sender side, so we always return 200
 * for processing errors to avoid pointless retries, and log internally.
 */

import { NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit";
import { recordFailedCharge } from "@/lib/failed-charge";
import { reconChargeId } from "@/lib/subscription-reconcile";
import { SCHEDULE_RECON_ID_PREFIX } from "@/lib/payment-schedule-reconcile";

// ---------- checkout.session.completed payload (legacy) ----------

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

// ---------- New-style event payloads ----------

type WebhookEventData = {
  subscription_id?: number | null;
  schedule_id?: number | null;
  payment_schedule_id?: number | null;
  scheduled_payment_id?: number | null;
  transaction_id?: number | null;
  customer_id?: number | null;
  customer_email?: string | null;
  amount_cents?: number | null;
  currency?: string | null;
  payment_method?: "cc" | "ach" | null;
  error?: string | null;
  consecutive_failures?: number | null;
  auto_cancelled?: boolean | null;
  refunded_amount_cents?: number | null;
  full_refund?: boolean | null;
  created_at?: string | null;
  paid_at?: string | null;
  transaction_date?: string | null;
};

type WebhookEnvelope = {
  event?: string;
  timestamp?: string;
  organization_id?: number;
  data?: WebhookEventData;
};

type SubRecord = Awaited<ReturnType<typeof prisma.subscription.findUnique>>;
type SchedRecord = Awaited<ReturnType<typeof prisma.paymentSchedule.findUnique>>;

type ResolvedContext = {
  customer: { id: string; clinicId: string | null } | null;
  clinicId: string | null;
  paymentMethodId: string | null;
  subscription: SubRecord;
  schedule: SchedRecord;
};

// ---------- Helpers ----------

function computeNextPaymentOn(frequency: string, from?: Date | null): Date {
  // Advance from the cycle's known due date when we have it, so a webhook that
  // arrives (or is reprocessed) late doesn't drift the schedule forward off
  // "now". Falls back to today for the first/unknown cycle.
  const base =
    from && !Number.isNaN(from.getTime()) ? new Date(from) : new Date();
  const d = new Date(base);
  const advance = (dt: Date) => {
    switch (frequency) {
      case "weekly":
        dt.setDate(dt.getDate() + 7);
        break;
      case "quarterly":
        dt.setMonth(dt.getMonth() + 3);
        break;
      case "yearly":
        dt.setFullYear(dt.getFullYear() + 1);
        break;
      default: // monthly
        dt.setMonth(dt.getMonth() + 1);
    }
  };
  advance(d);
  // If we processed a very late webhook, keep stepping forward so the stored
  // next-payment date is never left in the past (it's a display mirror; LP's
  // cron drives the real charges).
  const now = new Date();
  let guard = 0;
  while (d <= now && guard < 120) {
    advance(d);
    guard += 1;
  }
  return d;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ---------- Route ----------

/** Non-PHI identifiers safe to log (never names/emails/phones). */
function webhookRefIds(data: WebhookEventData) {
  return {
    subscription_id: data.subscription_id,
    payment_schedule_id: data.payment_schedule_id,
    transaction_id: data.transaction_id,
    customer_id: data.customer_id,
  };
}

export async function POST(req: Request) {
  const rawBody = await req.text();
  const secret = process.env.LUNARPAY_WEBHOOK_SECRET;

  // Fail closed: an unset secret must reject, not accept unsigned posts — this
  // endpoint can create charges and cancel subscriptions.
  if (!secret) {
    console.error("[webhook/lunarpay] LUNARPAY_WEBHOOK_SECRET unset — rejecting");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 503 });
  }
  {
    const sigHeader = req.headers.get("x-lunarpay-signature") ?? "";
    const timestamp = req.headers.get("x-lunarpay-timestamp") ?? "";
    const expected =
      "sha256=" +
      crypto
        .createHmac("sha256", secret)
        .update(`${timestamp}.${rawBody}`)
        .digest("hex");
    if (!safeEqual(sigHeader, expected)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  let payload: WebhookEnvelope;
  try {
    payload = JSON.parse(rawBody) as WebhookEnvelope;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const event =
    (typeof payload.event === "string" && payload.event) ||
    req.headers.get("x-lunarpay-event") ||
    "";

  try {
    switch (event) {
      case "checkout.session.completed":
        await handleSessionCompleted(payload as unknown as CheckoutSessionCompletedPayload);
        break;

      case "payment.succeeded":
      case "charge.succeeded":
        await handlePaymentSucceeded(event, payload);
        break;

      case "payment.failed":
      case "charge.failed":
        await handlePaymentFailed(event, payload);
        break;

      case "payment.refunded":
        await handlePaymentRefunded(payload);
        break;

      case "subscription.cancelled":
        await handleSubscriptionCancelled(payload);
        break;

      default:
        console.info(`[webhook/lunarpay] unhandled event: ${event || "(none)"}`);
    }
  } catch (err) {
    console.error(`[webhook/lunarpay] error handling ${event}:`, err);
    // Return 200 anyway so the sender's fire-and-forget delivery doesn't retry forever.
  }

  return NextResponse.json({ ok: true });
}

/**
 * Map an event's `data` block to one of our customers / subscriptions /
 * schedules via subscription_id, schedule id, LunarPay customer id, or email.
 */
async function resolveContext(data: WebhookEventData): Promise<ResolvedContext> {
  let subscription: SubRecord = null;
  let schedule: SchedRecord = null;
  let customer: { id: string; clinicId: string | null } | null = null;

  if (data.subscription_id) {
    subscription = await prisma.subscription.findUnique({
      where: { lunarpaySubscriptionId: Number(data.subscription_id) },
    });
  }
  const scheduleId = data.payment_schedule_id ?? data.schedule_id;
  if (!subscription && scheduleId) {
    schedule = await prisma.paymentSchedule.findUnique({
      where: { lunarpayScheduleId: Number(scheduleId) },
    });
  }

  const sourceCustomerId = subscription?.customerId ?? schedule?.customerId ?? null;
  if (sourceCustomerId) {
    customer = await prisma.customer.findUnique({
      where: { id: sourceCustomerId },
      select: { id: true, clinicId: true },
    });
  }
  if (!customer && data.customer_id) {
    customer = await prisma.customer.findFirst({
      where: { lunarpayCustomerId: Number(data.customer_id) },
      select: { id: true, clinicId: true },
    });
  }
  if (!customer && data.customer_email) {
    customer = await prisma.customer.findFirst({
      where: { email: data.customer_email },
      select: { id: true, clinicId: true },
    });
  }

  const clinicId =
    subscription?.clinicId ?? schedule?.clinicId ?? customer?.clinicId ?? null;
  const paymentMethodId =
    subscription?.paymentMethodId ?? schedule?.paymentMethodId ?? null;

  return { customer, clinicId, paymentMethodId, subscription, schedule };
}

function eventKind(ctx: ResolvedContext, event: string): string {
  if (ctx.subscription) return "Subscription renewal";
  if (ctx.schedule) return "Installment payment";
  return event.startsWith("charge.") ? "Charge" : "Payment";
}

function webhookTransactionDate(
  data: WebhookEventData,
  payload: WebhookEnvelope,
): Date {
  for (const value of [
    data.paid_at,
    data.transaction_date,
    data.created_at,
    payload.timestamp,
  ]) {
    if (!value) continue;
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

function utcDayBounds(date: Date): { gte: Date; lte: Date } {
  return {
    gte: new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    ),
    lte: new Date(
      Date.UTC(
        date.getUTCFullYear(),
        date.getUTCMonth(),
        date.getUTCDate(),
        23,
        59,
        59,
        999,
      ),
    ),
  };
}

/**
 * Locate the schedule item a succeeded installment webhook refers to, so the
 * mirrored charge can carry the date the payment was SCHEDULED for and the
 * snapshot's per-item status stays truthful.
 *
 * Match order: LunarPay's scheduled_payment_id (snapshot items keep their LP
 * ids) → same-amount item due on the transaction's UTC day → the only
 * remaining same-amount candidate (preferring non-failed). When several
 * equal-amount items remain ambiguous, match NOTHING rather than guess — a
 * wrong "(scheduled …)" stamp on a charge is permanent.
 *
 * `alreadyPaid` means the matched item was mirrored before (e.g. by the
 * nightly reconciler) — callers must not add its amount to the schedule's
 * paid total a second time.
 */
function resolveScheduleItem(
  paymentsJson: string | null,
  data: WebhookEventData,
  amountCents: number,
  occurredAt: Date,
): {
  scheduledFor: string | null;
  alreadyPaid: boolean;
  updatedPaymentsJson: string | null;
} {
  const none = { scheduledFor: null, alreadyPaid: false, updatedPaymentsJson: null };
  if (!paymentsJson) return none;
  let items: { id?: number; amount?: number; date?: string; status?: string }[];
  try {
    const parsed = JSON.parse(paymentsJson);
    if (!Array.isArray(parsed)) return none;
    items = parsed;
  } catch {
    return none;
  }
  let item =
    data.scheduled_payment_id != null
      ? items.find((p) => p.id === data.scheduled_payment_id)
      : undefined;
  if (!item) {
    const day = occurredAt.toISOString().slice(0, 10);
    const candidates = items.filter(
      (p) =>
        Math.round(Number(p.amount)) === amountCents &&
        p.status !== "paid" &&
        p.status !== "cancelled",
    );
    const sameDay = candidates.filter(
      (p) => typeof p.date === "string" && p.date.slice(0, 10) === day,
    );
    const nonFailed = candidates.filter((p) => p.status !== "failed");
    item =
      sameDay[0] ??
      (nonFailed.length === 1
        ? nonFailed[0]
        : candidates.length === 1
          ? candidates[0]
          : undefined);
  }
  if (!item || typeof item.date !== "string") return none;
  const scheduledFor = item.date.slice(0, 10);
  if (item.status === "paid") {
    return { scheduledFor, alreadyPaid: true, updatedPaymentsJson: null };
  }
  item.status = "paid";
  return {
    scheduledFor,
    alreadyPaid: false,
    updatedPaymentsJson: JSON.stringify(items),
  };
}

async function handlePaymentSucceeded(event: string, payload: WebhookEnvelope) {
  const data = payload.data ?? {};
  const ctx = await resolveContext(data);
  if (!ctx.customer) {
    console.warn(
      `[webhook/lunarpay] ${event} could not map to a customer`,
      webhookRefIds(data),
    );
    return;
  }

  const txId = data.transaction_id != null ? String(data.transaction_id) : null;
  const providedAmount = Math.round(Number(data.amount_cents));
  const amountCents =
    Number.isFinite(providedAmount) && providedAmount > 0
      ? providedAmount
      : (ctx.subscription?.amountCents ?? 0);
  const pmType = data.payment_method ?? null;
  const kind = eventKind(ctx, event);
  const occurredAt = webhookTransactionDate(data, payload);
  // First pass only stamps the description; the authoritative snapshot/paid
  // update happens later inside a locked transaction on fresh state.
  const schedItem = ctx.schedule
    ? resolveScheduleItem(ctx.schedule.paymentsJson, data, amountCents, occurredAt)
    : { scheduledFor: null, alreadyPaid: false, updatedPaymentsJson: null };
  const description = schedItem.scheduledFor
    ? `${kind} (scheduled ${schedItem.scheduledFor}) (auto)`
    : `${kind} (auto)`;
  let newlySettled = false;

  if (txId && amountCents > 0) {
    // A succeeded webhook is authoritative, including ACH settlement. Update a
    // synchronously-created pending row instead of ignoring it forever.
    const existing = await prisma.charge.findUnique({
      where: { lunarpayChargeId: txId },
    });
    if (existing) {
      newlySettled = !["paid", "refunded"].includes(existing.status);
      await prisma.charge.update({
        where: { id: existing.id },
        data: {
          amountCents,
          status: existing.status === "refunded" ? "refunded" : "paid",
          paymentMethodType: pmType ?? existing.paymentMethodType,
          description: existing.description || description,
        },
      });
    } else {
      await prisma.charge.create({
        data: {
          clinicId: ctx.clinicId,
          customerId: ctx.customer.id,
          paymentMethodId: ctx.paymentMethodId,
          lunarpayChargeId: txId,
          amountCents,
          status: "paid",
          paymentMethodType: pmType,
          description,
          createdAt: occurredAt,
        },
      });
      newlySettled = true;
    }

    // Replace a nightly placeholder with the real LunarPay transaction id.
    if (ctx.subscription) {
      await prisma.charge.deleteMany({
        where: {
          lunarpayChargeId: reconChargeId(
            ctx.subscription.lunarpaySubscriptionId,
            occurredAt,
          ),
        },
      });
    }
    if (ctx.schedule) {
      const placeholder = await prisma.charge.findFirst({
        where: {
          lunarpayChargeId: {
            startsWith: `${SCHEDULE_RECON_ID_PREFIX}${ctx.schedule.lunarpayScheduleId}:`,
          },
          amountCents,
          createdAt: utcDayBounds(occurredAt),
        },
        select: { id: true },
      });
      if (placeholder) {
        await prisma.charge.delete({ where: { id: placeholder.id } });
      }
    }
  }

  // Duplicate deliveries must not advance subscription/schedule state twice.
  if (ctx.subscription && newlySettled) {
    await prisma.subscription.update({
      where: { id: ctx.subscription.id },
      data: {
        status: "active",
        nextPaymentOn: computeNextPaymentOn(
          ctx.subscription.frequency,
          ctx.subscription.nextPaymentOn,
        ),
      },
    });
  }

  // Track installment progress; mark completed once fully paid. Also persist
  // the matched item's paid status so the profile/report per-item lists stay
  // truthful instead of showing every item as still pending.
  //
  // Runs on FRESH row state under a row lock: concurrent deliveries for
  // equal-amount items must not lose each other's snapshot writes, and an
  // item the reconciler already mirrored (alreadyPaid) must not increment
  // paidAmountCents a second time.
  if (ctx.schedule && newlySettled) {
    const scheduleId = ctx.schedule.id;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "PaymentSchedule" WHERE id = ${scheduleId} FOR UPDATE`;
      const fresh = await tx.paymentSchedule.findUnique({
        where: { id: scheduleId },
      });
      if (!fresh) return;
      const freshItem = resolveScheduleItem(
        fresh.paymentsJson,
        data,
        amountCents,
        occurredAt,
      );
      const paid =
        fresh.paidAmountCents + (freshItem.alreadyPaid ? 0 : amountCents);
      await tx.paymentSchedule.update({
        where: { id: scheduleId },
        data: {
          paidAmountCents: paid,
          status: paid >= fresh.totalAmountCents ? "completed" : fresh.status,
          ...(freshItem.updatedPaymentsJson
            ? { paymentsJson: freshItem.updatedPaymentsJson }
            : {}),
        },
      });
    });
  }

  await logAudit({
    actorId: null,
    actorRole: "WEBHOOK",
    clinicId: ctx.clinicId,
    action: "charge.succeeded.webhook",
    targetType: "Customer",
    targetId: ctx.customer.id,
    metadata: { event, amountCents, transactionId: txId, newlySettled },
  });
}

async function handlePaymentFailed(event: string, payload: WebhookEnvelope) {
  const data = payload.data ?? {};
  const ctx = await resolveContext(data);
  if (!ctx.customer) {
    console.warn(
      `[webhook/lunarpay] ${event} could not map to a customer`,
      webhookRefIds(data),
    );
    return;
  }

  const kind = eventKind(ctx, event);
  const reason = String(data.error ?? event).slice(0, 200);
  const txId = data.transaction_id != null ? String(data.transaction_id) : null;

  // Fallback id must be DETERMINISTIC so a re-delivered event dedupes instead
  // of minting a duplicate failed row (Date.now() produced duplicates).
  const occurredDay = webhookTransactionDate(data, payload)
    .toISOString()
    .slice(0, 10);
  await recordFailedCharge({
    clinicId: ctx.clinicId,
    customerId: ctx.customer.id,
    paymentMethodId: ctx.paymentMethodId,
    amountCents: Math.max(0, Math.round(Number(data.amount_cents ?? 0))),
    reason,
    paymentMethodType: data.payment_method ?? null,
    description: `${kind} (auto)`,
    externalId:
      txId ??
      `${event}:${data.subscription_id ?? data.payment_schedule_id ?? ctx.customer.id}:${occurredDay}`,
  });

  // The sender auto-cancels a subscription after consecutive failures.
  if (data.auto_cancelled && ctx.subscription) {
    await prisma.subscription.update({
      where: { id: ctx.subscription.id },
      data: { status: "cancelled" },
    });
  }

  await logAudit({
    actorId: null,
    actorRole: "WEBHOOK",
    clinicId: ctx.clinicId,
    action: "charge.failed.webhook",
    targetType: "Customer",
    targetId: ctx.customer.id,
    metadata: {
      event,
      amountCents: data.amount_cents ?? 0,
      consecutiveFailures: data.consecutive_failures ?? null,
      autoCancelled: !!data.auto_cancelled,
    },
  });
}

/**
 * Refund issued on the LunarPay side (dashboard or another API caller).
 * Mirrors the refund onto the local charge. RevOS-initiated refunds already
 * wrote refundedCents synchronously, so this is idempotent: it only raises
 * refundedCents, never lowers it.
 */
async function handlePaymentRefunded(payload: WebhookEnvelope) {
  const data = payload.data ?? {};
  if (data.transaction_id == null) return;

  const charge = await prisma.charge.findUnique({
    where: { lunarpayChargeId: String(data.transaction_id) },
  });
  if (!charge) {
    console.warn(
      "[webhook/lunarpay] payment.refunded for unknown charge",
      data.transaction_id,
    );
    return;
  }

  const refundedCents = Math.max(
    0,
    Math.round(Number(data.refunded_amount_cents ?? 0)),
  );
  // RevOS-initiated refunds already recorded refundedCents synchronously and
  // then receive this same event back — adding would double-count. Take the
  // MAX instead: exact for full refunds and for the echo of our own refund;
  // a second LunarPay-side partial of the same size is the one case this
  // under-counts, which beats falsely marking charges fully refunded.
  const newRefunded = data.full_refund
    ? charge.amountCents
    : Math.min(charge.amountCents, Math.max(charge.refundedCents, refundedCents));
  if (newRefunded <= charge.refundedCents) {
    return; // nothing new (duplicate delivery or our own refund echoed back)
  }

  await prisma.charge.update({
    where: { id: charge.id },
    data: {
      refundedCents: Math.max(charge.refundedCents, newRefunded),
      status: newRefunded >= charge.amountCents ? "refunded" : charge.status,
    },
  });

  await logAudit({
    actorId: null,
    actorRole: "WEBHOOK",
    clinicId: charge.clinicId,
    action: "charge.refunded.webhook",
    targetType: "Charge",
    targetId: charge.id,
    metadata: {
      transactionId: String(data.transaction_id),
      refundedCents,
      fullRefund: !!data.full_refund,
    },
  });
}

async function handleSubscriptionCancelled(payload: WebhookEnvelope) {
  const data = payload.data ?? {};
  if (!data.subscription_id) return;

  const sub = await prisma.subscription.findUnique({
    where: { lunarpaySubscriptionId: Number(data.subscription_id) },
  });
  if (!sub || sub.status === "cancelled") return;

  await prisma.subscription.update({
    where: { id: sub.id },
    data: { status: "cancelled" },
  });

  await logAudit({
    actorId: null,
    actorRole: "WEBHOOK",
    clinicId: sub.clinicId,
    action: "subscription.cancelled.webhook",
    targetType: "Subscription",
    targetId: String(sub.lunarpaySubscriptionId),
    metadata: {
      reason: "auto_cancelled",
      consecutiveFailures: data.consecutive_failures ?? null,
    },
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
