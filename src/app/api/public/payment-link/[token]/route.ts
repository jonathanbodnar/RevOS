import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { logAudit } from "@/lib/audit";

/**
 * Public submit endpoint for a hosted payment link.
 *
 * Steps:
 *  1) Find or create a Customer for this clinic (matched by email).
 *  2) Ensure the customer has a `lunarpayCustomerId` (create one if missing).
 *  3) Save the card via LunarPay (vaults the ticket against the customer).
 *  4) Charge `amountCents` immediately. For combined links, this already
 *     bundles setup fee + (first sub if startOn=today). For "payment" / pure
 *     "subscription" it's just the single amount.
 *  5) For subscription / combined links, create the LunarPay subscription
 *     with a startOn that lines up the FIRST recurring charge correctly:
 *       - subscription mode: startOn = today (LP next charge in 1 freq)
 *       - combined w/ startsToday: startOn = today (LP next charge in 1 freq)
 *       - combined w/ future start: startOn = (futureDate - 1 freq) so LP's
 *         first charge runs ON the future date the clinic configured.
 *  6) Mark the CheckoutSession completed and link to the customer.
 */
const Body = z.object({
  ticketId: z.string().min(1),
  paymentMethod: z.enum(["cc", "ach"]).optional(),
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().optional(),
});

type Frequency = "weekly" | "monthly" | "quarterly" | "yearly";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  const { token } = await ctx.params;

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
    !["payment", "subscription", "combined"].includes(sess.mode) ||
    sess.status !== "open"
  ) {
    return NextResponse.json(
      { error: "Link expired or invalid" },
      { status: 404 },
    );
  }

  const { ticketId, paymentMethod, email, firstName, lastName, phone } = parsed.data;
  const meta = (sess.metadataJson ? safeJson(sess.metadataJson) : {}) as {
    frequency?: Frequency;
    setupFeeCents?: number;
    subscriptionAmountCents?: number;
    startOn?: string;
    startsToday?: boolean;
  };

  try {
    // 1) Find or create the Customer for this clinic.
    let customer = await prisma.customer.findFirst({
      where: { clinicId: sess.clinicId, email },
    });

    if (!customer) {
      customer = await prisma.customer.create({
        data: {
          clinicId: sess.clinicId,
          email,
          firstName,
          lastName,
          phone: phone ?? null,
        },
      });
      await logAudit({
        actorId: null,
        actorRole: "CUSTOMER",
        clinicId: sess.clinicId,
        action: "customer.create.payment_link",
        targetType: "Customer",
        targetId: customer.id,
        metadata: { email },
      });
    }

    // 2) Make sure they have a LunarPay customer id.
    if (!customer.lunarpayCustomerId) {
      const lpCustomer = await lunarpay.createCustomer({
        firstName,
        lastName,
        email,
        phone,
      });
      customer = await prisma.customer.update({
        where: { id: customer.id },
        data: { lunarpayCustomerId: lpCustomer.data.id },
      });
    }
    const lpCustomerId = customer.lunarpayCustomerId;
    if (!lpCustomerId) {
      return NextResponse.json(
        { error: "Failed to create LunarPay customer" },
        { status: 500 },
      );
    }

    // 3) Save the card.
    const existingCount = await prisma.paymentMethod.count({
      where: { customerId: customer.id, isActive: true },
    });
    const setDefault = existingCount === 0;

    const lpPm = await lunarpay.savePaymentMethod(lpCustomerId, {
      ticketId,
      paymentMethod,
      nameHolder: `${firstName} ${lastName}`.trim(),
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

    // 4) Charge the today total. Combined mode's `amountCents` already
    //    bundles setup fee + (sub if starting today); payment / subscription
    //    modes use their single amount.
    const description = sess.description
      ? `[${sess.clinic.name}] ${sess.description}`
      : `[${sess.clinic.name}]`;

    if (sess.amountCents > 0) {
      const lpCharge = await lunarpay.createCharge({
        customerId: lpCustomerId,
        paymentMethodId: lpPm.data.id,
        amount: sess.amountCents,
        description,
      });

      await prisma.charge.create({
        data: {
          clinicId: sess.clinicId,
          customerId: customer.id,
          paymentMethodId: pm.id,
          lunarpayChargeId: String(lpCharge.data.id),
          fortisTransactionId: lpCharge.data.fortisTransactionId ?? null,
          amountCents: lpCharge.data.amount,
          status: lpCharge.data.status,
          paymentMethodType: lpCharge.data.paymentMethod,
          description: sess.description ?? null,
        },
      });
    }

    // 5) Create the LP subscription if applicable.
    if (sess.mode === "subscription" || sess.mode === "combined") {
      const frequency: Frequency = (meta.frequency as Frequency) || "monthly";

      // Subscription amount: meta value for combined links; falls back to the
      // session amount for legacy "subscription" links.
      const subAmountCents =
        sess.mode === "combined"
          ? meta.subscriptionAmountCents ?? 0
          : sess.amountCents;

      // Calculate startOn so the FIRST LP charge lands when the clinic wants:
      //   nextPaymentOn = startOn + 1 frequency (per LP)
      //   ⇒ startOn = (desired_first_charge_date - 1 frequency)
      // For "starts today" cases, we set startOn = today so the next LP charge
      // happens 1 frequency from now (the first sub charge today was bundled
      // into the createCharge above).
      let lpStartOn: string;
      if (sess.mode === "combined" && meta.startOn && !meta.startsToday) {
        lpStartOn = subtractOneFrequency(meta.startOn, frequency);
      } else {
        lpStartOn = todayIso();
      }

      if (subAmountCents >= 50) {
        const lpSub = await lunarpay.createSubscription({
          customerId: lpCustomerId,
          paymentMethodId: lpPm.data.id,
          amount: subAmountCents,
          frequency,
          startOn: lpStartOn,
        });

        const nextPaymentOn = lpSub.data.nextPaymentOn
          ? new Date(lpSub.data.nextPaymentOn)
          : addOneFrequency(new Date(lpStartOn), frequency);

        await prisma.subscription.create({
          data: {
            clinicId: sess.clinicId,
            customerId: customer.id,
            paymentMethodId: pm.id,
            lunarpaySubscriptionId: lpSub.data.id,
            amountCents: subAmountCents,
            frequency,
            status: lpSub.data.status,
            startOn: lpSub.data.startOn ? new Date(lpSub.data.startOn) : new Date(lpStartOn),
            nextPaymentOn,
            description: sess.description ?? null,
          },
        });
      }
    }

    // 6) Mark session completed and link the customer.
    await prisma.checkoutSession.update({
      where: { id: sess.id },
      data: {
        status: "completed",
        completedAt: new Date(),
        customerId: customer.id,
      },
    });

    await logAudit({
      actorId: null,
      actorRole: "CUSTOMER",
      clinicId: sess.clinicId,
      action:
        sess.mode === "payment"
          ? "charge.complete.payment_link"
          : sess.mode === "subscription"
          ? "subscription.complete.payment_link"
          : "combined.complete.payment_link",
      targetType: "CheckoutSession",
      targetId: sess.id,
      metadata: { amountCents: sess.amountCents },
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    const status = e instanceof LunarPayError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Payment failed";
    const details = e instanceof LunarPayError ? e.details : undefined;
    console.error("[payment-link/public] error:", msg, details);
    return NextResponse.json({ error: msg, details }, { status });
  }
}

function todayIso(): string {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

function subtractOneFrequency(isoDate: string, frequency: Frequency): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
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
  return d.toISOString().slice(0, 10);
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

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
