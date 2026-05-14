import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { logAudit } from "@/lib/audit";
import { parseMoneyInputToCents } from "@/lib/format";

const Body = z.object({
  mode: z.enum(["payment", "subscription", "combined"]),
  amount: z.string().optional(),
  frequency: z.enum(["weekly", "monthly", "quarterly", "yearly"]).optional(),
  description: z.string().optional(),
  setupFee: z.string().optional(),
  subscriptionAmount: z.string().optional(),
  startAfterDays: z.string().optional(),
  trial: z.string().optional(),
});

export async function GET() {
  const session = await getSession();
  if (session?.user?.originalRole !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const links = await prisma.checkoutSession.findMany({
    where: {
      isGlobal: true,
      mode: { in: ["payment", "subscription", "combined"] },
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
      amountCents = 0;
    } else {
      amountCents = cents;
    }
  } else {
    if (!parsed.data.frequency) {
      return NextResponse.json(
        { error: "Frequency is required for subscriptions" },
        { status: 400 },
      );
    }

    const setupFeeCents =
      parseMoneyInputToCents(parsed.data.setupFee ?? "0") ?? 0;
    const subCents = parseMoneyInputToCents(
      parsed.data.subscriptionAmount ?? "",
    );
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
