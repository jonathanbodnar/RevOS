import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireClinicApi } from "@/lib/api-guard";
import { logAudit } from "@/lib/audit";
import { parseMoneyInputToCents } from "@/lib/format";

/**
 * Create a payment link hosted at /pay/[token] on revosportal.com.
 *
 * Three link shapes:
 *   - "payment":      one-time charge of `amount`
 *   - "subscription": recurring sub; first charge today, recurs every frequency
 *   - "combined":     setup fee charged today + a subscription that begins on
 *                     `startOn`. If startOn = today, the first sub charge is
 *                     bundled with the setup fee in today's transaction; if
 *                     startOn is in the future, only the setup fee is charged
 *                     today and the first sub charge runs on `startOn`.
 *
 * `amountCents` on the CheckoutSession always represents what gets charged
 * the day the customer submits the link. Subscription details live in
 * `metadataJson` so we don't need a schema migration.
 */
const Body = z.object({
  mode: z.enum(["payment", "subscription", "combined"]),
  amount: z.string().optional(),
  frequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]).optional(),
  description: z.string().optional(),
  // combined-mode fields
  setupFee: z.string().optional(),
  subscriptionAmount: z.string().optional(),
  startOn: z.string().optional(), // YYYY-MM-DD
});

function todayIso(): string {
  const d = new Date();
  const tz = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 10);
}

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
    amountCents = cents;
    metadata.frequency = parsed.data.frequency;
  } else {
    // combined
    if (!parsed.data.frequency) {
      return NextResponse.json(
        { error: "Frequency is required for subscriptions" },
        { status: 400 },
      );
    }
    if (!parsed.data.startOn) {
      return NextResponse.json(
        { error: "Start date is required" },
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

    const today = todayIso();
    const startsToday = parsed.data.startOn === today;

    if (parsed.data.startOn < today) {
      return NextResponse.json(
        { error: "Start date cannot be in the past" },
        { status: 400 },
      );
    }

    // Today's charge: setup fee + (sub amount if subscription starts today)
    amountCents = setupFeeCents + (startsToday ? subCents : 0);
    if (amountCents < 50) {
      return NextResponse.json(
        {
          error:
            "Today's charge must be at least $0.50 — add a setup fee or set the start date to today.",
        },
        { status: 400 },
      );
    }

    metadata = {
      ...metadata,
      frequency: parsed.data.frequency,
      setupFeeCents,
      subscriptionAmountCents: subCents,
      startOn: parsed.data.startOn,
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
