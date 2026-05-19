import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { logAudit } from "@/lib/audit";
import { requireStringParams } from "@/lib/route-params";
import { calcFee } from "@/lib/fees";

/**
 * Public submit endpoint for a reusable hosted payment link.
 *
 * Two distinct flows depending on the Fortis intention type:
 *
 * A) transactionId present (mode: "payment" → transaction intention):
 *    Fortis already charged the card inside the iframe. We create the customer
 *    and record the charge in our DB. We must NOT call lunarpay.createCharge()
 *    again — the money already moved.
 *
 * B) tokenizeId present (mode: "subscription" | "combined" | "installments" →
 *    tokenization intention): Fortis vaulted the card without ANY charge
 *    (no $0.01 auth). We:
 *    1) Create LunarPay customer.
 *    2) Attach the saved payment method via tokenizeId.
 *    3) Charge the setup fee (if amountCents > 0 and not a trial).
 *    4) Create the LunarPay subscription / installment schedule.
 *
 * `ticketId` (legacy hasRecurring path) is still accepted for backward compat.
 *
 * The CheckoutSession is never marked completed — payment links are reusable.
 */
const Body = z.object({
  // Exactly one of these must be present:
  tokenizeId: z.string().min(1).optional(),    // tokenization (vault-only) flow
  ticketId: z.string().min(1).optional(),      // legacy hasRecurring flow
  transactionId: z.string().min(1).optional(), // transaction (charge-in-iframe) flow
  paymentMethod: z.enum(["cc", "ach"]).optional(),
  // Card metadata Fortis returns alongside tokenize_success.
  lastFour: z.string().optional(),
  expMonth: z.string().optional(),
  expYear: z.string().optional(),
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().optional(),
  // For global links (clinicId = null on the session), the pay page passes the
  // clinic that shared the link so transactions are attributed correctly.
  clinicId: z.string().optional(),
}).refine(
  (d) => !!d.tokenizeId || !!d.ticketId || !!d.transactionId,
  { message: "tokenizeId, ticketId, or transactionId required" },
);

type Frequency = "weekly" | "monthly" | "quarterly" | "yearly";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const params = await requireStringParams(ctx.params, ["token"] as const);
  if (!params.ok) return params.response;
  const { token } = params.value;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const sess = await prisma.checkoutSession.findUnique({
    where: { token },
    include: { clinic: true },
  });
  if (
    !sess ||
    !["payment", "subscription", "combined", "installments"].includes(sess.mode) ||
    sess.status !== "open"
  ) {
    return NextResponse.json(
      { error: "Link expired or invalid" },
      { status: 404 },
    );
  }

  const {
    tokenizeId,
    ticketId,
    transactionId,
    paymentMethod,
    lastFour,
    expMonth,
    expYear,
    email,
    firstName,
    lastName,
    phone,
    clinicId: bodyClinicId,
  } = parsed.data;
  // For global links (sess.clinicId = null) use the clinic passed by the pay
  // page so transactions are attributed to the clinic that shared the link.
  const resolvedClinicId = sess.clinicId ?? bodyClinicId ?? null;
  const isTransactionFlow = !!transactionId && !tokenizeId && !ticketId;
  const meta = (sess.metadataJson ? safeJson(sess.metadataJson) : {}) as {
    frequency?: Frequency;
    setupFeeCents?: number;
    subscriptionAmountCents?: number;
    startAfterDays?: number;
    startsToday?: boolean;
    trial?: boolean;
    startOn?: string;
    // installments (all modes)
    installments?: boolean;
    scheduleType?: "frequency" | "dates";
    totalCents?: number;
    count?: number;
    perPaymentCents?: number[];  // array — one amount per payment
    remainingCount?: number;
    installFirstToday?: boolean;
    // custom-dates installments
    scheduledDates?: string[];
    firstIsToday?: boolean;
    // optional concurrent subscription
    subAmountCents?: number;
    subFrequency?: Frequency;
    subFirstChargeDate?: string | null; // "YYYY-MM-DD"; null = start immediately
  };

  try {
    // Always create a fresh Customer + LunarPay customer for this submit.
    // Reusable links must not collapse repeat submissions (even with the
    // same email) into a single customer record.
    const lpCustomer = await lunarpay.createCustomer({
      firstName,
      lastName,
      email,
      phone,
    });

    const customer = await prisma.customer.create({
      data: {
        clinicId: resolvedClinicId,
        lunarpayCustomerId: lpCustomer.data.id,
        email,
        firstName,
        lastName,
        phone: phone ?? null,
      },
    });
    await logAudit({
      actorId: null,
      actorRole: "CUSTOMER",
      clinicId: resolvedClinicId,
      action: "customer.create.payment_link",
      targetType: "Customer",
      targetId: customer.id,
      metadata: { email, paymentLinkId: sess.id },
    });

    const lpCustomerId = customer.lunarpayCustomerId;
    if (!lpCustomerId) {
      return NextResponse.json(
        { error: "Failed to create LunarPay customer" },
        { status: 500 },
      );
    }

    // ─── TRANSACTION FLOW (one-time payment) ──────────────────────────────
    // Fortis already charged the card inside the iframe (with processing fee
    // included in the intention amount). Record the fee-included total in DB.
    if (isTransactionFlow) {
      const clinicLabel = sess.clinic?.name ?? "RevOS";
      const { totalCents } = calcFee(sess.amountCents);
      await prisma.charge.create({
        data: {
          clinicId: resolvedClinicId,
          customerId: customer.id,
          paymentMethodId: null,
          paymentLinkId: sess.id,
          lunarpayChargeId: transactionId!,
          fortisTransactionId: transactionId!,
          amountCents: totalCents,
          status: "paid",
          paymentMethodType: paymentMethod ?? "cc",
          description: sess.description ?? `[${clinicLabel}]`,
        },
      });

      await logAudit({
        actorId: null,
        actorRole: "CUSTOMER",
        clinicId: resolvedClinicId,
        action: "charge.complete.payment_link",
        targetType: "CheckoutSession",
        targetId: sess.id,
        metadata: { amountCents: totalCents, customerId: customer.id, transactionId },
      });

      return NextResponse.json({ ok: true });
    }

    // ─── VAULT FLOW (subscription / combined / installments / trial) ──────
    // Fortis saved the card only (no $0.01 auth when using tokenization).
    // Vault it, optionally charge, then create the sub / schedule.

    const existingCount = await prisma.paymentMethod.count({
      where: { customerId: customer.id, isActive: true },
    });
    const setDefault = existingCount === 0;

    const lpPm = await lunarpay.savePaymentMethod(lpCustomerId, {
      tokenizeId,
      ticketId,
      paymentMethod,
      nameHolder: `${firstName} ${lastName}`.trim(),
      lastFour,
      expMonth,
      expYear,
      setDefault,
    });

    if (setDefault) {
      await prisma.paymentMethod.updateMany({
        where: { customerId: customer.id, isDefault: true },
        data: { isDefault: false },
      });
    }

    const pm = await prisma.paymentMethod.create({
      data: {
        customerId: customer.id,
        lunarpayPaymentMethodId: lpPm.data.id,
        sourceType: lpPm.data.sourceType,
        lastDigits: lpPm.data.lastDigits ?? null,
        nameHolder: lpPm.data.nameHolder ?? null,
        expMonth: lpPm.data.expMonth ?? null,
        expYear: lpPm.data.expYear ?? null,
        isDefault: !!lpPm.data.isDefault || setDefault,
        isActive: true,
      },
    });

    const clinicLabel = sess.clinic?.name ?? "RevOS";
    const description = sess.description
      ? `[${clinicLabel}] ${sess.description}`
      : `[${clinicLabel}]`;

    // 4) Charge the today total — skipped entirely for trial subscriptions.
    //    Combined mode's `amountCents` already bundles setup fee + (sub if
    //    starting today); subscription mode uses its amount. Processing fee
    //    (3.9% + $0.39) is added on top before sending to LunarPay.
    if (!meta.trial && sess.amountCents > 0) {
      const { totalCents: chargeTotal } = calcFee(sess.amountCents);
      const lpCharge = await lunarpay.createCharge({
        customerId: lpCustomerId,
        paymentMethodId: lpPm.data.id,
        amount: chargeTotal,
        description,
      });

      await prisma.charge.create({
        data: {
          clinicId: resolvedClinicId,
          customerId: customer.id,
          paymentMethodId: pm.id,
          paymentLinkId: sess.id,
          lunarpayChargeId: String(lpCharge.data.id),
          fortisTransactionId: lpCharge.data.fortisTransactionId ?? null,
          amountCents: lpCharge.data.amount,
          status: lpCharge.data.status,
          paymentMethodType: lpCharge.data.paymentMethod,
          description: sess.description ?? null,
        },
      });
    }

    // 5a) Create installment schedule if this is an installments link.
    if (sess.mode === "installments" && meta.installments) {
      const perPaymentCentsArr = Array.isArray(meta.perPaymentCents)
        ? meta.perPaymentCents
        : Array(meta.count ?? 1).fill(meta.perPaymentCents ?? 0);

      const scheduleType = meta.scheduleType ?? "frequency";

      // Build scheduled payments list (excluding the first if charged today)
      let payments: { amount: number; date: string }[] = [];

      if (scheduleType === "dates") {
        const dates = meta.scheduledDates ?? [];
        const firstIsToday = meta.firstIsToday ?? false;
        const startIdx = firstIsToday ? 1 : 0;
        payments = dates.slice(startIdx).map((date, i) => {
          const base = perPaymentCentsArr[startIdx + i] ?? perPaymentCentsArr[0];
          return { amount: calcFee(base).totalCents, date };
        });
      } else {
        const frequency: Frequency = (meta.frequency as Frequency) || "monthly";
        const remainingCount = meta.remainingCount ?? 0;
        let nextDate = addOneFrequency(new Date(), frequency);
        for (let i = 0; i < remainingCount; i++) {
          const base = perPaymentCentsArr[i + 1] ?? perPaymentCentsArr[0];
          payments.push({
            amount: calcFee(base).totalCents,
            date: nextDate.toISOString().slice(0, 10),
          });
          nextDate = addOneFrequency(nextDate, frequency);
        }
      }

      if (payments.length > 0) {
        const lpSchedule = await lunarpay.createSchedule({
          customerId: lpCustomerId,
          paymentMethodId: lpPm.data.id,
          description,
          payments,
        });

        const firstPaymentCents = perPaymentCentsArr[0] ?? 0;
        const chargedToday = scheduleType === "dates"
          ? (meta.firstIsToday ? firstPaymentCents : 0)
          : (meta.installFirstToday ? firstPaymentCents : 0);

        await prisma.paymentSchedule.create({
          data: {
            clinicId: resolvedClinicId,
            customerId: customer.id,
            paymentMethodId: pm.id,
            lunarpayScheduleId: lpSchedule.data.id,
            totalAmountCents: meta.totalCents ?? 0,
            paidAmountCents: chargedToday,
            status: lpSchedule.data.status,
            description: sess.description ?? null,
          },
        });
      }

      // Optional concurrent subscription — startOn computed from desired first charge date.
      if (meta.subAmountCents && meta.subFrequency && meta.subAmountCents >= 50) {
        const lpStartOn = meta.subFirstChargeDate
          ? subtractOneFrequency(meta.subFirstChargeDate, meta.subFrequency)
          : todayIso();

        const { totalCents: subTotal } = calcFee(meta.subAmountCents);
        const lpSub = await lunarpay.createSubscription({
          customerId: lpCustomerId,
          paymentMethodId: lpPm.data.id,
          amount: subTotal,
          frequency: meta.subFrequency,
          startOn: lpStartOn,
        });

        const nextPaymentOn = lpSub.data.nextPaymentOn
          ? new Date(lpSub.data.nextPaymentOn)
          : addOneFrequency(new Date(lpStartOn), meta.subFrequency);

        await prisma.subscription.create({
          data: {
            clinicId: resolvedClinicId,
            customerId: customer.id,
            paymentMethodId: pm.id,
            paymentLinkId: sess.id,
            lunarpaySubscriptionId: lpSub.data.id,
            amountCents: subTotal,
            frequency: meta.subFrequency,
            status: lpSub.data.status,
            startOn: new Date(lpStartOn),
            nextPaymentOn,
            description: sess.description ?? null,
          },
        });
      }

      await logAudit({
        actorId: null,
        actorRole: "CUSTOMER",
        clinicId: resolvedClinicId,
        action: "installments.complete.payment_link",
        targetType: "CheckoutSession",
        targetId: sess.id,
        metadata: { totalCents: meta.totalCents, count: meta.count, customerId: customer.id },
      });

      return NextResponse.json({ ok: true });
    }

    // 5b) Create the LP subscription if applicable.
    if (sess.mode === "subscription" || sess.mode === "combined") {
      const frequency: Frequency = (meta.frequency as Frequency) || "monthly";

      // Subscription amount: meta value for combined links; falls back to the
      // session amount for legacy "subscription" links.
      // For trial links the real subscription amount lives in meta since
      // sess.amountCents is 0 (nothing charged day-of).
      const subAmountCents =
        sess.mode === "combined"
          ? meta.subscriptionAmountCents ?? 0
          : meta.trial
          ? meta.subscriptionAmountCents ?? sess.amountCents
          : sess.amountCents;

      // Calculate startOn so the FIRST LP charge lands when the clinic wants:
      //   nextPaymentOn = startOn + 1 frequency (per LP)
      //   ⇒ startOn = (desired_first_charge_date - 1 frequency)
      // For "starts today" cases (subscription mode, or combined with
      // startAfterDays = 0), startOn = today so the next LP charge happens
      // 1 frequency from now (the first sub charge for today was already
      // bundled into the createCharge above).
      // For combined with N-day delay, desiredFirstCharge = today + N days,
      // and startOn = (desiredFirstCharge - 1 frequency).
      let lpStartOn: string;
      if (sess.mode === "combined") {
        const startAfterDays = resolveStartAfterDays(meta);
        if (startAfterDays > 0) {
          const desired = addDaysIso(todayIso(), startAfterDays);
          lpStartOn = subtractOneFrequency(desired, frequency);
        } else {
          lpStartOn = todayIso();
        }
      } else {
        lpStartOn = todayIso();
      }

      if (subAmountCents >= 50) {
        const { totalCents: subBillingTotal } = calcFee(subAmountCents);
        const lpSub = await lunarpay.createSubscription({
          customerId: lpCustomerId,
          paymentMethodId: lpPm.data.id,
          amount: subBillingTotal,
          frequency,
          startOn: lpStartOn,
          trial: !!meta.trial,
        });

        const nextPaymentOn = lpSub.data.nextPaymentOn
          ? new Date(lpSub.data.nextPaymentOn)
          : addOneFrequency(new Date(lpStartOn), frequency);

        await prisma.subscription.create({
          data: {
            clinicId: resolvedClinicId,
            customerId: customer.id,
            paymentMethodId: pm.id,
            paymentLinkId: sess.id,
            lunarpaySubscriptionId: lpSub.data.id,
            amountCents: subBillingTotal,
            frequency,
            status: lpSub.data.status,
            startOn: lpSub.data.startOn ? new Date(lpSub.data.startOn) : new Date(lpStartOn),
            nextPaymentOn,
            description: sess.description ?? null,
          },
        });
      }
    }

    // 6) Reusable link — DO NOT mark the session completed. The link stays
    //    active so other customers can pay through the same URL.
    await logAudit({
      actorId: null,
      actorRole: "CUSTOMER",
      clinicId: resolvedClinicId,
      action:
        meta.trial
          ? "trial_subscription.complete.payment_link"
          : sess.mode === "payment"
          ? "charge.complete.payment_link"
          : sess.mode === "subscription"
          ? "subscription.complete.payment_link"
          : "combined.complete.payment_link",
      targetType: "CheckoutSession",
      targetId: sess.id,
      metadata: {
        amountCents: sess.amountCents,
        customerId: customer.id,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    const status = e instanceof LunarPayError ? e.status : 500;
    const baseMsg = e instanceof Error ? e.message : "Payment failed";
    const details = e instanceof LunarPayError ? e.details : undefined;

    // If LP returned a structured `errors` object, surface the first concrete
    // field-level message so the page shows something more useful than just
    // "Validation error".
    let displayMsg = baseMsg;
    if (details && typeof details === "object") {
      const d = details as { errors?: Record<string, unknown>; message?: string };
      if (d.errors && typeof d.errors === "object") {
        const firstField = Object.entries(d.errors)[0];
        if (firstField) {
          const [field, msg] = firstField;
          const msgStr = Array.isArray(msg) ? msg[0] : msg;
          displayMsg = `${baseMsg}: ${field} — ${String(msgStr)}`;
        }
      } else if (d.message && d.message !== baseMsg) {
        displayMsg = `${baseMsg}: ${d.message}`;
      }
    }

    console.error("[payment-link/public] error:", displayMsg, details);
    return NextResponse.json({ error: displayMsg, details }, { status });
  }
}

function todayIso(): string {
  // LunarPay expects full ISO timestamps with Z (e.g. "2026-06-06T00:00:00Z").
  const d = new Date();
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0),
  )
    .toISOString()
    .replace(".000Z", "Z");
}

function subtractOneFrequency(isoDate: string, frequency: Frequency): string {
  // Accepts "YYYY-MM-DD" or full ISO; returns full ISO with Z (LP format).
  const d = new Date(
    isoDate.length === 10 ? `${isoDate}T00:00:00Z` : isoDate,
  );
  switch (frequency) {
    case "weekly":
      d.setUTCDate(d.getUTCDate() - 7);
      break;
    case "quarterly":
      d.setUTCMonth(d.getUTCMonth() - 3);
      break;
    case "yearly":
      d.setUTCFullYear(d.getUTCFullYear() - 1);
      break;
    default:
      d.setUTCMonth(d.getUTCMonth() - 1);
  }
  return d.toISOString().replace(".000Z", "Z");
}

function addOneFrequency(d: Date, frequency: Frequency): Date {
  const out = new Date(d);
  switch (frequency) {
    case "weekly":
      out.setDate(out.getDate() + 7);
      break;
    case "quarterly":
      out.setMonth(out.getMonth() + 3);
      break;
    case "yearly":
      out.setFullYear(out.getFullYear() + 1);
      break;
    default:
      out.setMonth(out.getMonth() + 1);
  }
  return out;
}

function addDaysIso(isoDate: string, days: number): string {
  // Adds N days to a UTC ISO timestamp, preserving the LP "...Z" format.
  const d = new Date(
    isoDate.length === 10 ? `${isoDate}T00:00:00Z` : isoDate,
  );
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().replace(".000Z", "Z");
}

/**
 * Backwards-compat: links created before the relative-start change stored an
 * absolute `startOn` calendar date. For those, treat startAfterDays as the
 * delta between today and that stored date (clamped to non-negative).
 */
function resolveStartAfterDays(meta: {
  startAfterDays?: number;
  startsToday?: boolean;
  startOn?: string;
}): number {
  if (typeof meta.startAfterDays === "number") return Math.max(0, meta.startAfterDays);
  if (meta.startsToday) return 0;
  if (meta.startOn) {
    const target = new Date(
      meta.startOn.length === 10 ? `${meta.startOn}T00:00:00Z` : meta.startOn,
    );
    const today = new Date(todayIso());
    const days = Math.round((target.getTime() - today.getTime()) / (24 * 60 * 60 * 1000));
    return Math.max(0, days);
  }
  return 0;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
