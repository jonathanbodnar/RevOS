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
  mode: z.enum(["payment", "subscription", "combined", "installments"]),
  amount: z.string().optional(),
  frequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]).optional(),
  description: z.string().optional(),
  // combined-mode fields
  setupFee: z.string().optional(),
  subscriptionAmount: z.string().optional(),
  startAfterDays: z.string().optional(),
  // subscription trial — card saved, no day-of charge
  trial: z.string().optional(),
  // installments-mode fields
  installTotal: z.string().optional(),
  installCount: z.string().optional(),
  installAmounts: z.string().optional(),       // JSON: string[] of per-payment USD amounts
  installScheduleType: z.enum(["frequency", "dates"]).optional(),
  installFrequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]).optional(),
  installFirstToday: z.string().optional(),
  installDates: z.string().optional(),         // JSON: string[] of "YYYY-MM-DD" per payment
  // optional subscription that starts after last installment
  installSubAmount: z.string().optional(),
  installSubFrequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]).optional(),
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
  } else if (parsed.data.mode === "combined") {
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
  } else if (parsed.data.mode === "installments") {
    const totalCents = parseMoneyInputToCents(parsed.data.installTotal ?? "");
    if (totalCents === null || totalCents < 100) {
      return NextResponse.json(
        { error: "Total amount must be at least $1.00" },
        { status: 400 },
      );
    }
    const count = Number.parseInt(parsed.data.installCount ?? "3", 10);
    if (!Number.isFinite(count) || count < 2 || count > 24) {
      return NextResponse.json(
        { error: "Number of payments must be between 2 and 24" },
        { status: 400 },
      );
    }

    // Parse per-payment amounts (may be blank = evenly split)
    let rawAmounts: string[] = [];
    try {
      rawAmounts = JSON.parse(parsed.data.installAmounts ?? "[]") as string[];
    } catch { /* ignore, fall back to even split */ }

    // Resolve each payment's cents: use supplied amount if valid, else split total
    const perPaymentCents = rawAmounts.map((a) => {
      const c = parseMoneyInputToCents(a ?? "");
      return c && c >= 50 ? c : Math.round(totalCents / count);
    });
    if (perPaymentCents.length < count) {
      while (perPaymentCents.length < count) {
        perPaymentCents.push(Math.round(totalCents / count));
      }
    }

    if (perPaymentCents.some((c) => c < 50)) {
      return NextResponse.json(
        { error: "Each payment must be at least $0.50" },
        { status: 400 },
      );
    }

    const scheduleType = parsed.data.installScheduleType ?? "frequency";

    if (scheduleType === "dates") {
      // ── Custom-dates mode ──────────────────────────────────────────
      let dates: string[] = [];
      try {
        dates = JSON.parse(parsed.data.installDates ?? "[]") as string[];
      } catch {
        return NextResponse.json({ error: "Invalid installDates" }, { status: 400 });
      }
      if (dates.length !== count) {
        return NextResponse.json(
          { error: `Expected ${count} dates, got ${dates.length}` },
          { status: 400 },
        );
      }

      const today = new Date().toISOString().slice(0, 10);
      const firstIsToday = dates[0] <= today;
      // Day-of charge = first payment if its date is today or in the past
      amountCents = firstIsToday ? perPaymentCents[0] : 0;

      // Optional subscription after last payment
      let subMeta: Record<string, unknown> = {};
      if (parsed.data.installSubAmount && parsed.data.installSubFrequency) {
        const subCents = parseMoneyInputToCents(parsed.data.installSubAmount);
        if (subCents && subCents >= 50) {
          subMeta = {
            subAmountCents: subCents,
            subFrequency: parsed.data.installSubFrequency,
          };
        }
      }

      metadata = {
        ...metadata,
        installments: true,
        scheduleType: "dates",
        totalCents,
        count,
        perPaymentCents,
        scheduledDates: dates,
        firstIsToday,
        ...subMeta,
      };
    } else {
      // ── Frequency mode ─────────────────────────────────────────────
      if (!parsed.data.installFrequency) {
        return NextResponse.json(
          { error: "Frequency is required for installments" },
          { status: 400 },
        );
      }
      const installFirstToday = parsed.data.installFirstToday !== "false";
      amountCents = installFirstToday ? perPaymentCents[0] : 0;

      let subMeta: Record<string, unknown> = {};
      if (parsed.data.installSubAmount && parsed.data.installSubFrequency) {
        const subCents = parseMoneyInputToCents(parsed.data.installSubAmount);
        if (subCents && subCents >= 50) {
          subMeta = {
            subAmountCents: subCents,
            subFrequency: parsed.data.installSubFrequency,
          };
        }
      }

      metadata = {
        ...metadata,
        installments: true,
        scheduleType: "frequency",
        totalCents,
        count,
        perPaymentCents,
        frequency: parsed.data.installFrequency,
        installFirstToday,
        remainingCount: installFirstToday ? count - 1 : count,
        ...subMeta,
      };
    }
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
