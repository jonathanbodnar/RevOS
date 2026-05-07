import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { logAudit } from "@/lib/audit";
import { requireStringParams } from "@/lib/route-params";

/**
 * Public submit endpoint for a reusable hosted payment link.
 *
 * Steps:
 *  1) Always create a fresh Customer for this clinic. Reusable links are
 *     intentionally NOT keyed off email — every submission produces a new
 *     customer profile, even if the email matches an existing one.
 *  2) Create a LunarPay customer for this fresh record.
 *  3) Save the card via LunarPay (vaults the ticket against the customer).
 *  4) Charge `amountCents` immediately. For combined links, this already
 *     bundles setup fee + (first sub if startAfterDays=0). For "payment" /
 *     pure "subscription" it's just the single amount.
 *  5) For subscription / combined links, create the LunarPay subscription
 *     with a startOn that lines up the FIRST recurring charge correctly:
 *       - subscription mode: startOn = today (LP next charge in 1 freq)
 *       - combined w/ startsToday: startOn = today (LP next charge in 1 freq)
 *       - combined w/ N-day delay: desiredFirstCharge = today + N days,
 *         startOn = (desiredFirstCharge - 1 freq) so LP's first charge
 *         runs exactly N days from this customer's payment day.
 *  6) Leave the CheckoutSession open — payment links are reusable, so any
 *     number of customers can pay through the same token.
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
    startAfterDays?: number;
    startsToday?: boolean;
    // legacy field on links created before the relative-start change
    startOn?: string;
  };

  try {
    // 1) Always create a fresh Customer + LunarPay customer for this submit.
    //    Reusable links must not collapse repeat submissions (even with the
    //    same email) into a single customer record.
    const lpCustomer = await lunarpay.createCustomer({
      firstName,
      lastName,
      email,
      phone,
    });

    const customer = await prisma.customer.create({
      data: {
        clinicId: sess.clinicId,
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
      clinicId: sess.clinicId,
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
    const clinicLabel = sess.clinic?.name ?? "RevOS";
    const description = sess.description
      ? `[${clinicLabel}] ${sess.description}`
      : `[${clinicLabel}]`;

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
            paymentLinkId: sess.id,
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

    // 6) Reusable link — DO NOT mark the session completed. The link stays
    //    active so other customers can pay through the same URL.
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
