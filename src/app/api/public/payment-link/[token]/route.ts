import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { logAudit } from "@/lib/audit";

/**
 * Public submit endpoint for a hosted payment link.
 *
 * Inputs from the page:
 *  - ticketId: Fortis ticket from Elements (card is already vaulted at Fortis)
 *  - email + firstName + lastName + (optional) phone
 *
 * What we do, in order:
 *  1) Find or create a Customer for this clinic (matched by email).
 *  2) Ensure the customer has a `lunarpayCustomerId` (create one if missing).
 *  3) Save the card via LunarPay (vaults the ticket against the customer).
 *  4) For mode="payment": charge immediately via LunarPay.
 *     For mode="subscription": charge first, then create the subscription
 *     so future recurrences run automatically.
 *  5) Mark the CheckoutSession as completed.
 *
 * Idempotency: if the session is already "completed", we return success
 * without doing anything else.
 */
const Body = z.object({
  ticketId: z.string().min(1),
  paymentMethod: z.enum(["cc", "ach"]).optional(),
  email: z.string().email(),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  phone: z.string().optional(),
});

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
    (sess.mode !== "payment" && sess.mode !== "subscription") ||
    sess.status !== "open"
  ) {
    return NextResponse.json(
      { error: "Link expired or invalid" },
      { status: 404 },
    );
  }

  const { ticketId, paymentMethod, email, firstName, lastName, phone } = parsed.data;

  try {
    // 1) Find or create the Customer in this clinic (match by email).
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

    // Type narrowing — at this point we definitely have an LP id.
    const lpCustomerId = customer.lunarpayCustomerId;
    if (!lpCustomerId) {
      return NextResponse.json(
        { error: "Failed to create LunarPay customer" },
        { status: 500 },
      );
    }

    // 3) Save the card (vault the Fortis ticket against the LP customer).
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

    // 4a) Charge first (always — this is the initial payment).
    const description = sess.description
      ? `[${sess.clinic.name}] ${sess.description}`
      : `[${sess.clinic.name}]`;

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

    // 4b) For subscription links, create the recurring plan now that the
    // first charge has been captured. nextPaymentOn = startOn + 1 frequency
    // (LP default), which means "next charge in one frequency unit".
    if (sess.mode === "subscription") {
      const meta = sess.metadataJson ? safeJson(sess.metadataJson) : {};
      const frequency = (meta as Record<string, string>).frequency || "monthly";

      const lpSub = await lunarpay.createSubscription({
        customerId: lpCustomerId,
        paymentMethodId: lpPm.data.id,
        amount: sess.amountCents,
        frequency: frequency as "weekly" | "monthly" | "quarterly" | "yearly",
      });

      const nextPaymentOn = lpSub.data.nextPaymentOn
        ? new Date(lpSub.data.nextPaymentOn)
        : computeNextPaymentOn(frequency);

      await prisma.subscription.create({
        data: {
          clinicId: sess.clinicId,
          customerId: customer.id,
          paymentMethodId: pm.id,
          lunarpaySubscriptionId: lpSub.data.id,
          amountCents: sess.amountCents,
          frequency,
          status: lpSub.data.status,
          startOn: lpSub.data.startOn ? new Date(lpSub.data.startOn) : new Date(),
          nextPaymentOn,
          description: sess.description ?? null,
        },
      });
    }

    // 5) Mark session completed and link to the customer.
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
        sess.mode === "subscription"
          ? "subscription.complete.payment_link"
          : "charge.complete.payment_link",
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
    default:
      d.setMonth(d.getMonth() + 1);
  }
  return d;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}
