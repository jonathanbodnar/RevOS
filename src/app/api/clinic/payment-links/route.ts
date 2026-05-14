import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { logAudit } from "@/lib/audit";
import { parseMoneyInputToCents } from "@/lib/format";

/**
 * Create a reusable payment link hosted at /pay/[token] on revosportal.com.
 *
 * Three link shapes:
 *   - "payment":      one-time charge of `amount` per customer.
 *   - "subscription": recurring sub; first charge runs the day the customer
 *                     pays, then every `frequency` after.
 *   - "combined":     setup fee charged today (= the day each customer pays)
 *                     + a subscription whose first charge runs
 *                     `startAfterDays` days later. Because the link is
 *                     reusable and shared with many customers, the start
 *                     date is RELATIVE to each customer's payment day, not
 *                     a fixed calendar date.
 *
 * `amountCents` on the CheckoutSession represents what gets charged the day
 * a customer submits the link. Subscription details (frequency, sub amount,
 * setup fee, days-until-first-sub-charge) live in `metadataJson`.
 */
const Body = z.object({
  mode: z.enum(["payment", "subscription", "combined"]),
  amount: z.string().optional(),
  frequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]).optional(),
  description: z.string().optional(),
  // combined-mode fields
  setupFee: z.string().optional(),
  subscriptionAmount: z.string().optional(),
  // Number of days after the customer's payment that the first recurring
  // subscription charge should run. 0 = bundled with today's setup fee.
  startAfterDays: z.string().optional(),
  // When true, the card is saved but no charge is made on day-of. The
  // subscription starts without an initial payment.
  trial: z.string().optional(),
});

export async function POST(req: Request) {
  const guard = await requireClinicApi();
  if ("error" in guard) return guard.error;
  const { session, clinicId } = guard;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId } });
  if (!clinic) {
    return NextResponse.json({ error: "Clinic not found" }, { status: 404 });
  }

  let amountCents = 0;
  let metadata: Record<string, unknown> = { clinicId };

  if (parsed.data.mode === "payment") {
    const cents = parseMoneyInputToCents(parsed.data.amount ?? "");
    if (cents === null || cents < 50) {
      return NextResponse.json(
        { error: "Amount must be at least $0.50" },
        { status: 400 },
      );
    }
    amountCents = cents;
  } else if (parsed.data.mode === "subscription") {
    if (!parsed.data.frequency) {
      return NextResponse.json(
        { error: "Frequency is required for subscriptions" },
        { status: 400 },
      );
    }
    const cents = parseMoneyInputToCents(parsed.data.amount ?? "");
    if (cents === null || cents < 50) {
      return NextResponse.json(
        { error: "Amount must be at least $0.50" },
        { status: 400 },
      );
    }
    const isTrial = parsed.data.trial === "true";
    metadata.frequency = parsed.data.frequency;
    metadata.trial = isTrial;
    metadata.subscriptionAmountCents = cents;
    if (isTrial) {
      // Trial: no day-of charge. The card is saved, subscription created
      // without an initial payment.
      amountCents = 0;
    } else {
      amountCents = cents;
    }
  } else {
    // combined
    if (!parsed.data.frequency) {
      return NextResponse.json(
        { error: "Frequency is required for subscriptions" },
        { status: 400 },
      );
    }

    const setupFeeCents = parseMoneyInputToCents(parsed.data.setupFee ?? "0") ?? 0;
    const subCents = parseMoneyInputToCents(parsed.data.subscriptionAmount ?? "");
    if (subCents === null || subCents < 50) {
      return NextResponse.json(
        { error: "Subscription amount must be at least $0.50" },
        { status: 400 },
      );
    }

    const startAfterDaysRaw = parsed.data.startAfterDays ?? "0";
    const startAfterDays = Number.parseInt(startAfterDaysRaw, 10);
    if (
      !Number.isFinite(startAfterDays) ||
      startAfterDays < 0 ||
      startAfterDays > 365
    ) {
      return NextResponse.json(
        {
          error:
            "First subscription charge must be 0–365 days after the customer pays.",
        },
        { status: 400 },
      );
    }

    const startsToday = startAfterDays === 0;

    // What gets charged the day a customer submits the link: setup fee plus
    // — only when startAfterDays is 0 — the first subscription installment.
    amountCents = setupFeeCents + (startsToday ? subCents : 0);
    if (amountCents < 50) {
      return NextResponse.json(
        {
          error:
            "Day-of charge must be at least $0.50 — add a setup fee or set start days to 0.",
        },
        { status: 400 },
      );
    }

    metadata = {
      ...metadata,
      frequency: parsed.data.frequency,
      setupFeeCents,
      subscriptionAmountCents: subCents,
      startAfterDays,
      startsToday,
    };
  }

  const token = randomBytes(24).toString("hex");
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const url = `${appUrl}/pay/${token}`;

  // CheckoutSession.lunarpaySessionId is a unique Int; payment-link sessions
  // are not real LunarPay sessions, so we use a negative sentinel.
  const negId = -Math.floor(Math.random() * 1_000_000_000);

  const checkoutSession = await prisma.checkoutSession.create({
    data: {
      clinicId,
      customerId: null,
      lunarpaySessionId: negId,
      token,
      url,
      amountCents,
      description: parsed.data.description ?? null,
      mode: parsed.data.mode,
      status: "open",
      metadataJson: JSON.stringify(metadata),
    },
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId,
    action:
      parsed.data.mode === "payment"
        ? "invoice.link.create"
        : parsed.data.mode === "subscription"
        ? "subscription.link.create"
        : "combined.link.create",
    targetType: "CheckoutSession",
    targetId: checkoutSession.id,
    metadata: { amountCents, mode: parsed.data.mode },
  });

  return NextResponse.json({ url, id: checkoutSession.id });
}
