import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { logAudit } from "@/lib/audit";
import { parseMoneyInputToCents } from "@/lib/format";

const Body = z.object({
  mode: z.enum(["payment", "subscription", "combined", "installments", "master"]),
  amount: z.string().optional(),
  frequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]).optional(),
  description: z.string().optional(),
  // combined
  setupFee: z.string().optional(),
  subscriptionAmount: z.string().optional(),
  startAfterDays: z.string().optional(),
  // subscription trial
  trial: z.string().optional(),
  // installments
  installTotal: z.string().optional(),
  installCount: z.string().optional(),
  installAmounts: z.string().optional(),
  installScheduleType: z.enum(["frequency", "dates"]).optional(),
  installFrequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]).optional(),
  installFirstToday: z.string().optional(),
  installDates: z.string().optional(),
  installDelays: z.string().optional(),
  installSubAmount: z.string().optional(),
  installSubFrequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]).optional(),
  installSubFirstCharge: z.string().optional(),
  installSubStartAfterDays: z.string().optional(),
});

export async function GET() {
  const session = await getSession();
  if (session?.user?.originalRole !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const links = await prisma.checkoutSession.findMany({
    where: {
      isGlobal: true,
      mode: { in: ["payment", "subscription", "combined", "installments", "master"] },
      customerId: null,
    },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { charges: true, subscriptions: true } },
    },
  });

  return NextResponse.json({ links });
}

export async function POST(req: Request) {
  const session = await getSession();
  if (session?.user?.originalRole !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  let amountCents = 0;
  let metadata: Record<string, unknown> = { isGlobal: true };

  if (parsed.data.mode === "master") {
    // Configurable link — the payer chooses amounts at checkout. Nothing is
    // fixed at creation; the day-of charge is computed server-side on submit.
    amountCents = 0;
    metadata = { ...metadata, master: true };

    const token = randomBytes(24).toString("hex");
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const url = `${appUrl}/pay/${token}`;
    const negId = -Math.floor(Math.random() * 1_000_000_000);

    const checkoutSession = await prisma.checkoutSession.create({
      data: {
        clinicId: null,
        customerId: null,
        lunarpaySessionId: negId,
        token,
        url,
        amountCents,
        description: parsed.data.description ?? null,
        mode: "master",
        status: "open",
        metadataJson: JSON.stringify(metadata),
        isGlobal: true,
      },
    });

    await logAudit({
      actorId: session.user.id,
      actorRole: session.user.originalRole,
      clinicId: null,
      action: "payment_link.global.create",
      targetType: "CheckoutSession",
      targetId: checkoutSession.id,
      metadata: { mode: "master" },
    });

    return NextResponse.json({ url, id: checkoutSession.id }, { status: 201 });
  } else if (parsed.data.mode === "payment") {
    const cents = parseMoneyInputToCents(parsed.data.amount ?? "");
    if (cents === null || cents < 50) {
      return NextResponse.json({ error: "Amount must be at least $0.50" }, { status: 400 });
    }
    amountCents = cents;
  } else if (parsed.data.mode === "subscription") {
    if (!parsed.data.frequency) {
      return NextResponse.json({ error: "Frequency is required" }, { status: 400 });
    }
    const cents = parseMoneyInputToCents(parsed.data.amount ?? "");
    if (cents === null || cents < 50) {
      return NextResponse.json({ error: "Amount must be at least $0.50" }, { status: 400 });
    }
    const isTrial = parsed.data.trial === "true";
    metadata.frequency = parsed.data.frequency;
    metadata.trial = isTrial;
    metadata.subscriptionAmountCents = cents;
    amountCents = isTrial ? 0 : cents;
  } else if (parsed.data.mode === "combined") {
    if (!parsed.data.frequency) {
      return NextResponse.json({ error: "Frequency is required" }, { status: 400 });
    }
    const setupFeeCents = parseMoneyInputToCents(parsed.data.setupFee ?? "0") ?? 0;
    const subCents = parseMoneyInputToCents(parsed.data.subscriptionAmount ?? "");
    if (subCents === null || subCents < 50) {
      return NextResponse.json({ error: "Subscription amount must be at least $0.50" }, { status: 400 });
    }
    const startAfterDays = Number.parseInt(parsed.data.startAfterDays ?? "0", 10);
    if (!Number.isFinite(startAfterDays) || startAfterDays < 0 || startAfterDays > 365) {
      return NextResponse.json({ error: "First subscription charge must be 0–365 days after payment." }, { status: 400 });
    }
    const startsToday = startAfterDays === 0;
    amountCents = setupFeeCents + (startsToday ? subCents : 0);
    if (amountCents < 50) {
      return NextResponse.json({ error: "Day-of charge must be at least $0.50." }, { status: 400 });
    }
    metadata = { ...metadata, frequency: parsed.data.frequency, setupFeeCents, subscriptionAmountCents: subCents, startAfterDays, startsToday };
  } else {
    // installments
    const totalCents = parseMoneyInputToCents(parsed.data.installTotal ?? "");
    if (totalCents === null || totalCents < 100) {
      return NextResponse.json({ error: "Total amount must be at least $1.00" }, { status: 400 });
    }
    const count = Number.parseInt(parsed.data.installCount ?? "3", 10);
    if (!Number.isFinite(count) || count < 2 || count > 24) {
      return NextResponse.json({ error: "Number of payments must be between 2 and 24" }, { status: 400 });
    }

    let rawAmounts: string[] = [];
    try { rawAmounts = JSON.parse(parsed.data.installAmounts ?? "[]") as string[]; } catch { /* ignore */ }

    const perPaymentCents = rawAmounts.map((a) => {
      const c = parseMoneyInputToCents(a ?? "");
      return c && c >= 50 ? c : Math.round(totalCents / count);
    });
    while (perPaymentCents.length < count) perPaymentCents.push(Math.round(totalCents / count));

    if (perPaymentCents.some((c) => c < 50)) {
      return NextResponse.json({ error: "Each payment must be at least $0.50" }, { status: 400 });
    }

    const scheduleType = parsed.data.installScheduleType ?? "frequency";

    let subMeta: Record<string, unknown> = {};
    if (parsed.data.installSubAmount && parsed.data.installSubFrequency) {
      const subCents = parseMoneyInputToCents(parsed.data.installSubAmount);
      if (subCents && subCents >= 50) {
        subMeta = {
          subAmountCents: subCents,
          subFrequency: parsed.data.installSubFrequency,
          subStartAfterDays: parsed.data.installSubStartAfterDays ? Number(parsed.data.installSubStartAfterDays) : 0,
          subFirstChargeDate: parsed.data.installSubFirstCharge ?? null,
        };
      }
    }

    if (scheduleType === "dates") {
      let delays: number[] = [];
      try {
        delays = JSON.parse(parsed.data.installDelays ?? "[]") as number[];
      } catch {
        let dates: string[] = [];
        try { dates = JSON.parse(parsed.data.installDates ?? "[]") as string[]; } catch {
          return NextResponse.json({ error: "Invalid installDelays" }, { status: 400 });
        }
        if (dates.length !== count) {
          return NextResponse.json({ error: `Expected ${count} dates, got ${dates.length}` }, { status: 400 });
        }
        const today = new Date().toISOString().slice(0, 10);
        const firstIsToday = dates[0] <= today;
        amountCents = firstIsToday ? perPaymentCents[0] : 0;
        metadata = { ...metadata, installments: true, scheduleType: "dates", totalCents, count, perPaymentCents, scheduledDates: dates, firstIsToday, ...subMeta };
        return proceedWithCreate();
      }

      if (delays.length !== count - 1) {
        return NextResponse.json({ error: `Expected ${count - 1} delays, got ${delays.length}` }, { status: 400 });
      }

      // First payment is charged day-of
      amountCents = perPaymentCents[0];
      metadata = {
        ...metadata,
        installments: true,
        scheduleType: "dates",
        totalCents,
        count,
        perPaymentCents,
        daysDelays: delays,
        firstIsToday: true,
        ...subMeta,
      };

      function proceedWithCreate() {
        // Fallback placeholder
      }
    } else {
      if (!parsed.data.installFrequency) {
        return NextResponse.json({ error: "Frequency is required for installments" }, { status: 400 });
      }
      const installFirstToday = parsed.data.installFirstToday !== "false";
      amountCents = installFirstToday ? perPaymentCents[0] : 0;
      metadata = { ...metadata, installments: true, scheduleType: "frequency", totalCents, count, perPaymentCents, frequency: parsed.data.installFrequency, installFirstToday, remainingCount: installFirstToday ? count - 1 : count, ...subMeta };
    }
  }

  const token = randomBytes(24).toString("hex");
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const url = `${appUrl}/pay/${token}`;
  const negId = -Math.floor(Math.random() * 1_000_000_000);

  const checkoutSession = await prisma.checkoutSession.create({
    data: {
      clinicId: null,
      customerId: null,
      lunarpaySessionId: negId,
      token,
      url,
      amountCents,
      description: parsed.data.description ?? null,
      mode: parsed.data.mode,
      status: "open",
      metadataJson: JSON.stringify(metadata),
      isGlobal: true,
    },
  });

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId: null,
    action: "payment_link.global.create",
    targetType: "CheckoutSession",
    targetId: checkoutSession.id,
    metadata: { amountCents, mode: parsed.data.mode },
  });

  return NextResponse.json({ url, id: checkoutSession.id }, { status: 201 });
}
