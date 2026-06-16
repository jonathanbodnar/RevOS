import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { logAudit } from "@/lib/audit";
import { requireStringParams } from "@/lib/route-params";
import { calcFee } from "@/lib/fees";
import { resolveOrCreateImplementorByName } from "@/lib/implementor";
import {
  MASTER_SUBSCRIPTION_CENTS,
  MASTER_SUBSCRIPTION_FREQUENCY,
  MASTER_SUBSCRIPTION_DEFAULT_DAYS,
} from "@/lib/master-link";

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
 *    tokenization intention): Fortis vaulted the card without ANY charge.
 *    We:
 *    1) Create LunarPay customer.
 *    2) Attach the saved payment method via tokenizeId.
 *    3) Run the day-of charge via createCharge (setup fee, first sub
 *       payment, or first installment) — skipped for trials and for
 *       installments where the first payment is deferred.
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
  // Sales attribution from the ?implementor=<name> tag on the link URL.
  implementor: z.string().optional(),
  // Master (configurable) link: amounts/schedule chosen by the payer at
  // checkout. Only used when sess.mode === "master".
  master: z
    .object({
      downPaymentCents: z.number().int().min(0), // 0 allowed (subscription-only)
      split: z.boolean(),
      firstPaymentCents: z.number().int().min(50).optional(), // amount due today when split
      // Optional "YYYY-MM-DD": when set, the (first) down payment is scheduled
      // for that date instead of charged immediately at checkout.
      firstPaymentDate: z.string().optional(),
      secondPaymentDate: z.string().optional(), // "YYYY-MM-DD", required if split
      // Care credit = financed by the clinic externally: logged, NOT charged.
      firstIsCareCredit: z.boolean().optional(),
      secondIsCareCredit: z.boolean().optional(),
      subscription: z.boolean(),
      subscriptionDate: z.string().optional(), // "YYYY-MM-DD"; defaults to +30 days
    })
    .optional(),
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
    !["payment", "subscription", "combined", "installments", "master"].includes(sess.mode) ||
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
    implementor: implementorName,
    master: masterCfg,
  } = parsed.data;
  // For global links (sess.clinicId = null) use the clinic passed by the pay
  // page so transactions are attributed to the clinic that shared the link.
  const resolvedClinicId = sess.clinicId ?? bodyClinicId ?? null;

  // Only the one-time "payment" mode can use the pure-transaction shortcut.
  // For sub/combined/installments we MUST have a vaulted card (need a
  // payment method id for future charges), so a tokenizeId/ticketId is
  // required.
  const isTransactionFlow = sess.mode === "payment" && !!transactionId;
  if (sess.mode !== "payment" && !tokenizeId && !ticketId) {
    return NextResponse.json(
      {
        error:
          "Card was not vaulted — cannot start subscription/installment plan. Please try again.",
      },
      { status: 400 },
    );
  }
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
    daysDelays?: number[];
    firstIsToday?: boolean;
    // optional concurrent subscription
    subAmountCents?: number;
    subFrequency?: Frequency;
    subFirstChargeDate?: string | null; // "YYYY-MM-DD"; null = start immediately
    subStartAfterDays?: number;
  };

  // Track which stage we're in so the error log tells us exactly where the
  // failure happened (LunarPay call N out of M).
  let stage = "start";
  try {
    // Create-or-reuse the customer. LunarPay upserts by email (returns the
    // same customer id with created:false for a repeat email), and our
    // Customer.lunarpayCustomerId is unique — so a returning customer (e.g.
    // someone whose first attempt was declined but whose account was already
    // created) maps back to the SAME LunarPay id. We must reuse the existing
    // local row instead of trying to create a duplicate, which would otherwise
    // fail the unique constraint and lock them out of ever paying.
    stage = "createCustomer";
    const lpCustomer = await lunarpay.createCustomer({
      firstName,
      lastName,
      email,
      phone,
    });

    const existingCustomer = await prisma.customer.findUnique({
      where: { lunarpayCustomerId: lpCustomer.data.id },
    });

    // Resolve the ?implementor= tag to an implementor id (creating it if new).
    const implementorId = await resolveOrCreateImplementorByName(implementorName);

    const customer = existingCustomer
      ? await prisma.customer.update({
          where: { id: existingCustomer.id },
          data: {
            email,
            firstName,
            lastName,
            phone: phone ?? existingCustomer.phone,
            // Attribute to this clinic only if not already attributed, so a
            // returning customer is never silently moved between clinics.
            ...(existingCustomer.clinicId ? {} : { clinicId: resolvedClinicId }),
            // Set the implementor only if the tag is present and the customer
            // isn't already attributed to one.
            ...(implementorId && !existingCustomer.implementorId
              ? { implementorId }
              : {}),
          },
        })
      : await prisma.customer.create({
          data: {
            clinicId: resolvedClinicId,
            lunarpayCustomerId: lpCustomer.data.id,
            email,
            firstName,
            lastName,
            phone: phone ?? null,
            ...(implementorId ? { implementorId } : {}),
          },
        });

    await logAudit({
      actorId: null,
      actorRole: "CUSTOMER",
      clinicId: resolvedClinicId,
      action: existingCustomer
        ? "customer.reuse.payment_link"
        : "customer.create.payment_link",
      targetType: "Customer",
      targetId: customer.id,
      metadata: { email, paymentLinkId: sess.id, returning: !!existingCustomer },
    });

    const lpCustomerId = customer.lunarpayCustomerId;
    if (!lpCustomerId) {
      return NextResponse.json(
        { error: "Failed to create LunarPay customer" },
        { status: 500 },
      );
    }

    // ─── PURE TRANSACTION FLOW (one-time payment, no vault) ───────────────
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

    stage = "savePaymentMethod";
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
        lunarpayCustomerId: lpCustomerId,
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

    // ─── MASTER (configurable) FLOW ───────────────────────────────────────
    // The payer chose the amounts at checkout. Charge the down payment now
    // (full, or first half when split), schedule the second half if split,
    // and start the fixed $250/mo subscription if enabled. Processing fee is
    // applied to every payment.
    if (sess.mode === "master") {
      if (!masterCfg) {
        return NextResponse.json(
          { error: "Missing payment configuration. Please try again." },
          { status: 400 },
        );
      }

      const downCents = masterCfg.downPaymentCents;
      // Down payment of $0 is allowed only when a subscription is enabled
      // (start a subscription with no money down). Split is meaningless at $0.
      const isSplit = masterCfg.split && downCents > 0;

      if (downCents === 0 && !masterCfg.subscription) {
        return NextResponse.json(
          { error: "Enter a down payment or enable the subscription." },
          { status: 400 },
        );
      }

      // Amount due today: payer-specified when split (defaults to half), else
      // the full down payment.
      const firstBase = isSplit
        ? masterCfg.firstPaymentCents ?? Math.floor(downCents / 2)
        : downCents;
      const secondBase = isSplit ? downCents - firstBase : 0;

      if (isSplit && (firstBase < 50 || secondBase < 50 || firstBase > downCents)) {
        return NextResponse.json(
          {
            error:
              "Each split payment must be at least $0.50 and the first payment can't exceed the total.",
          },
          { status: 400 },
        );
      }
      if (isSplit && !masterCfg.secondPaymentDate) {
        return NextResponse.json(
          { error: "A date for the second payment is required." },
          { status: 400 },
        );
      }

      // When the payer chose to schedule the first/down payment for later, we
      // defer it instead of charging at checkout.
      const todayStr = todayIso().slice(0, 10);
      const deferFirst =
        !!masterCfg.firstPaymentDate && masterCfg.firstPaymentDate >= todayStr;
      if (masterCfg.firstPaymentDate && masterCfg.firstPaymentDate < todayStr) {
        return NextResponse.json(
          { error: "The first payment date can't be in the past." },
          { status: 400 },
        );
      }

      // Care-credit flags: such payments are financed by the clinic externally
      // and are LOGGED, never charged through Fortis.
      const firstIsCareCredit = !!masterCfg.firstIsCareCredit && firstBase >= 1;
      const secondIsCareCredit =
        isSplit && !!masterCfg.secondIsCareCredit && secondBase >= 1;

      // Collect every payment that should be scheduled (vs charged today) so we
      // can register them in a single LunarPay payment-schedule.
      const scheduledPayments: { amount: number; date: string }[] = [];
      let chargedTodayBase = 0;
      const careCreditLogs: { amountCents: number }[] = [];

      // 1) First/down payment: care credit (log only), charge today, or schedule.
      if (firstIsCareCredit) {
        careCreditLogs.push({ amountCents: firstBase });
      } else if (firstBase >= 50) {
        if (deferFirst && masterCfg.firstPaymentDate) {
          scheduledPayments.push({
            amount: calcFee(firstBase).totalCents,
            date: masterCfg.firstPaymentDate,
          });
        } else {
          const { totalCents: firstTotal } = calcFee(firstBase);
          stage = "createCharge.master.downPayment";
          const lpCharge = await lunarpay.createCharge({
            customerId: lpCustomerId,
            paymentMethodId: lpPm.data.id,
            amount: firstTotal,
            description,
          });
          chargedTodayBase = firstBase;
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
      }

      // 2) Second half: care credit (log only) or scheduled on the chosen date.
      if (secondIsCareCredit) {
        careCreditLogs.push({ amountCents: secondBase });
      } else if (isSplit && secondBase >= 50 && masterCfg.secondPaymentDate) {
        scheduledPayments.push({
          amount: calcFee(secondBase).totalCents,
          date: masterCfg.secondPaymentDate,
        });
      }

      // Log any care-credit payments (no Fortis charge — clinic financed it).
      for (const log of careCreditLogs) {
        await prisma.careCredit.create({
          data: {
            clinicId: resolvedClinicId,
            customerId: customer.id,
            amountCents: log.amountCents,
            collectedOn: new Date(),
            source: "master_link",
            note: "Care credit (master link)",
          },
        });
      }

      // Register any deferred payments as one LunarPay schedule.
      if (scheduledPayments.length > 0) {
        stage = "createSchedule.master";
        const lpSchedule = await lunarpay.createSchedule({
          customerId: lpCustomerId,
          paymentMethodId: lpPm.data.id,
          description,
          payments: scheduledPayments,
        });
        await prisma.paymentSchedule.create({
          data: {
            clinicId: resolvedClinicId,
            customerId: customer.id,
            paymentMethodId: pm.id,
            lunarpayScheduleId: lpSchedule.data.id,
            totalAmountCents: downCents,
            paidAmountCents: chargedTodayBase,
            status: lpSchedule.data.status,
            description: sess.description ?? null,
            paymentsJson: JSON.stringify(scheduledPayments),
          },
        });
      }

      // 3) Fixed $250/mo subscription starting on the chosen date (default +30d).
      if (masterCfg.subscription) {
        const subDate =
          masterCfg.subscriptionDate ||
          addDaysIso(todayIso(), MASTER_SUBSCRIPTION_DEFAULT_DAYS);
        const lpStartOn = subtractOneFrequency(subDate, MASTER_SUBSCRIPTION_FREQUENCY);
        const { totalCents: subTotal } = calcFee(MASTER_SUBSCRIPTION_CENTS);

        stage = "createSubscription.master";
        const lpSub = await lunarpay.createSubscription({
          customerId: lpCustomerId,
          paymentMethodId: lpPm.data.id,
          amount: subTotal,
          frequency: MASTER_SUBSCRIPTION_FREQUENCY,
          startOn: lpStartOn,
        });

        const nextPaymentOn = lpSub.data.nextPaymentOn
          ? new Date(lpSub.data.nextPaymentOn)
          : addOneFrequency(new Date(lpStartOn), MASTER_SUBSCRIPTION_FREQUENCY);

        await prisma.subscription.create({
          data: {
            clinicId: resolvedClinicId,
            customerId: customer.id,
            paymentMethodId: pm.id,
            paymentLinkId: sess.id,
            lunarpaySubscriptionId: lpSub.data.id,
            amountCents: subTotal,
            frequency: MASTER_SUBSCRIPTION_FREQUENCY,
            status: lpSub.data.status,
            startOn: lpSub.data.startOn ? new Date(lpSub.data.startOn) : new Date(lpStartOn),
            nextPaymentOn,
            description: sess.description ?? null,
          },
        });
      }

      await logAudit({
        actorId: null,
        actorRole: "CUSTOMER",
        clinicId: resolvedClinicId,
        action: "master.complete.payment_link",
        targetType: "CheckoutSession",
        targetId: sess.id,
        metadata: {
          downPaymentCents: downCents,
          split: masterCfg.split,
          subscription: masterCfg.subscription,
          careCreditCents: careCreditLogs.reduce((s, l) => s + l.amountCents, 0),
          customerId: customer.id,
        },
      });

      return NextResponse.json({ ok: true });
    }

    // 4) Day-of charge — skipped entirely for trial subscriptions.
    //    Combined mode's `amountCents` already bundles setup fee + (sub if
    //    starting today); subscription mode uses its amount; installments
    //    use the first-payment amount (or 0 if first payment is deferred).
    //    Processing fee (3.9% + $0.39) is added on top before sending to
    //    LunarPay.
    if (!meta.trial && sess.amountCents > 0) {
      const { totalCents: chargeTotal } = calcFee(sess.amountCents);
      stage = "createCharge.dayOf";
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
        if (meta.daysDelays) {
          // Relative days delay mode
          const delays = meta.daysDelays;
          const today = new Date();
          const dates: string[] = [today.toISOString().slice(0, 10)];

          let currentDate = today;
          for (const delay of delays) {
            const nextDate = new Date(currentDate);
            nextDate.setDate(nextDate.getDate() + delay);
            dates.push(nextDate.toISOString().slice(0, 10));
            currentDate = nextDate;
          }

          // First payment is charged today, remaining are scheduled
          payments = dates.slice(1).map((date, i) => {
            const base = perPaymentCentsArr[1 + i] ?? perPaymentCentsArr[0];
            return { amount: calcFee(base).totalCents, date };
          });
        } else {
          // Legacy absolute dates fallback
          const dates = meta.scheduledDates ?? [];
          const firstIsToday = meta.firstIsToday ?? false;
          const startIdx = firstIsToday ? 1 : 0;
          payments = dates.slice(startIdx).map((date, i) => {
            const base = perPaymentCentsArr[startIdx + i] ?? perPaymentCentsArr[0];
            return { amount: calcFee(base).totalCents, date };
          });
        }
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
        stage = "createSchedule.installments";
        const lpSchedule = await lunarpay.createSchedule({
          customerId: lpCustomerId,
          paymentMethodId: lpPm.data.id,
          description,
          payments,
        });

        const firstPaymentCents = perPaymentCentsArr[0] ?? 0;
        const chargedToday = scheduleType === "dates"
          ? (meta.daysDelays ? firstPaymentCents : (meta.firstIsToday ? firstPaymentCents : 0))
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
        let lpStartOn: string;
        if (meta.subStartAfterDays !== undefined) {
          const startAfterDays = Number(meta.subStartAfterDays);
          if (startAfterDays > 0) {
            const desired = addDaysIso(todayIso(), startAfterDays);
            lpStartOn = subtractOneFrequency(desired, meta.subFrequency);
          } else {
            lpStartOn = todayIso();
          }
        } else if (meta.subFirstChargeDate) {
          lpStartOn = subtractOneFrequency(meta.subFirstChargeDate, meta.subFrequency);
        } else {
          lpStartOn = todayIso();
        }

        const { totalCents: subTotal } = calcFee(meta.subAmountCents);
        stage = "createSubscription.concurrent";
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
        stage = "createSubscription";
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

    console.error(
      `[payment-link/public] FAILED at stage="${stage}" token=${token}`,
      { error: displayMsg, details, sessMode: sess.mode, sessAmountCents: sess.amountCents },
    );
    return NextResponse.json(
      { error: `${displayMsg} (stage: ${stage})`, stage, details },
      { status },
    );
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
