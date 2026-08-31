import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSuperAdminApi } from "@/lib/api-guard";
import { requireStringParams } from "@/lib/route-params";
import { prisma } from "@/lib/prisma";
import { lunarpay, LunarPayError } from "@/lib/lunarpay";
import { logAudit } from "@/lib/audit";
import { calcFee, baseCentsFromTotal } from "@/lib/fees";

export const dynamic = "force-dynamic";

const Body = z.object({
  paymentMethodId: z.string().min(1),
  // First billing date, YYYY-MM-DD. Must be in the future: a restart resumes
  // recurring billing, it never charges on the spot. Collecting a missed cycle
  // is a separate, deliberate one-off charge on the patient's profile.
  startOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

function addOneFrequency(d: Date, frequency: string): Date {
  const out = new Date(d);
  switch (frequency) {
    case "weekly":
      out.setUTCDate(out.getUTCDate() + 7);
      break;
    case "quarterly":
      out.setUTCMonth(out.getUTCMonth() + 3);
      break;
    case "yearly":
      out.setUTCFullYear(out.getUTCFullYear() + 1);
      break;
    default:
      out.setUTCMonth(out.getUTCMonth() + 1);
  }
  return out;
}

function subtractOneFrequency(d: Date, frequency: string): Date {
  const out = new Date(d);
  switch (frequency) {
    case "weekly":
      out.setUTCDate(out.getUTCDate() - 7);
      break;
    case "quarterly":
      out.setUTCMonth(out.getUTCMonth() - 3);
      break;
    case "yearly":
      out.setUTCFullYear(out.getUTCFullYear() - 1);
      break;
    default:
      out.setUTCMonth(out.getUTCMonth() - 1);
  }
  return out;
}

/**
 * Replace a subscription that stopped, on a card that works.
 *
 * LunarPay's cancel is a DELETE, so there is nothing to un-cancel — this always
 * creates a NEW subscription and links it back to the dead one.
 *
 * Deliberately never charges today. The saved-card create path bills the first
 * cycle immediately when startOn is today, and firing that from a list view
 * would bill a patient hundreds of dollars on one click. Billing resumes on the
 * chosen future date instead.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const guard = await requireSuperAdminApi();
  if ("error" in guard) return guard.error;

  const params = await requireStringParams(ctx.params, ["id"] as const);
  if (!params.ok) return params.response;
  const { id } = params.value;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const old = await prisma.subscription.findUnique({
    where: { id },
    include: { customer: { select: { id: true, lunarpayCustomerId: true } } },
  });
  if (!old) {
    return NextResponse.json({ error: "Subscription not found" }, { status: 404 });
  }
  if (old.status !== "cancelled") {
    return NextResponse.json(
      { error: "That subscription is not cancelled." },
      { status: 400 },
    );
  }

  // Refuse if this one was already restarted, so a double-click or a stale tab
  // cannot leave the patient on two concurrent subscriptions.
  const already = await prisma.subscription.findFirst({
    where: { restartedFromId: old.id },
    select: { id: true },
  });
  if (already) {
    return NextResponse.json(
      { error: "This subscription has already been restarted." },
      { status: 409 },
    );
  }
  const activeExists = await prisma.subscription.findFirst({
    where: { customerId: old.customerId, status: "active" },
    select: { id: true, amountCents: true },
  });
  if (activeExists) {
    return NextResponse.json(
      { error: "This patient already has an active subscription." },
      { status: 409 },
    );
  }

  const pm = await prisma.paymentMethod.findFirst({
    where: { id: parsed.data.paymentMethodId, customerId: old.customerId, isActive: true },
  });
  if (!pm) {
    return NextResponse.json({ error: "Payment method not found" }, { status: 404 });
  }

  // The stored amount already includes the processing fee. Re-running calcFee
  // over it would bill the fee twice, so recover the original base first.
  const baseCents = baseCentsFromTotal(old.amountCents);
  if (baseCents === null) {
    return NextResponse.json(
      { error: "Could not determine the original amount for this subscription." },
      { status: 422 },
    );
  }
  const { totalCents } = calcFee(baseCents);

  const startOnDate = new Date(`${parsed.data.startOn}T00:00:00.000Z`);
  if (Number.isNaN(startOnDate.getTime())) {
    return NextResponse.json({ error: "Invalid start date" }, { status: 400 });
  }
  const todayUtc = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z");
  if (startOnDate.getTime() <= todayUtc.getTime()) {
    return NextResponse.json(
      { error: "Pick a future date — restarting never charges the card today." },
      { status: 400 },
    );
  }

  // LunarPay bills at startOn + one cycle, so send the chosen date minus a
  // cycle to make the first charge land exactly on it (same as the create path).
  const lpStartOn = subtractOneFrequency(startOnDate, old.frequency)
    .toISOString()
    .replace(".000Z", "Z");

  const vaultOwnerId = pm.lunarpayCustomerId ?? old.customer.lunarpayCustomerId;
  if (!vaultOwnerId) {
    return NextResponse.json(
      { error: "Customer is not synced to LunarPay" },
      { status: 400 },
    );
  }

  // Claim the restart BEFORE calling LunarPay. The unique index on
  // restartedFromId makes this the actual concurrency guard: the reads above
  // are check-then-act with a multi-second network call inside the window, so
  // two overlapping requests would both pass them and both create a live
  // subscription. Losing this race must cost nothing, so it happens before any
  // billing exists.
  try {
    await prisma.subscriptionRestartClaim.create({ data: { restartedFromId: old.id } });
  } catch {
    return NextResponse.json(
      { error: "This subscription is already being restarted." },
      { status: 409 },
    );
  }

  try {
    const lpSub = await lunarpay.createSubscription({
      customerId: vaultOwnerId,
      paymentMethodId: pm.lunarpayPaymentMethodId,
      amount: totalCents,
      frequency: old.frequency as "weekly" | "monthly" | "quarterly" | "yearly",
      startOn: lpStartOn,
    });

    // Record the live subscription id immediately. If the write below fails,
    // this is the only trace that billing exists at the processor — without it
    // the subscription is invisible to the webhook (which maps by
    // lunarpaySubscriptionId), to the reconciler (which iterates our rows), and
    // to every screen that could cancel it.
    await logAudit({
      actorId: guard.session.user.id ?? null,
      actorRole: guard.session.user.originalRole,
      clinicId: old.clinicId,
      action: "subscription.restart.lunarpay_created",
      targetType: "Subscription",
      targetId: old.id,
      metadata: { lunarpaySubscriptionId: lpSub.data.id, totalCents },
    }).catch(() => null);

    let nextPaymentOn = lpSub.data.nextPaymentOn
      ? new Date(lpSub.data.nextPaymentOn)
      : addOneFrequency(new Date(lpStartOn), old.frequency);

    // Month-end round-trip can miss by a few days (Mar 31 → Feb has no 31st).
    // Repointing the date does not charge anything.
    if (nextPaymentOn.toISOString().slice(0, 10) !== parsed.data.startOn) {
      try {
        const fixed = await lunarpay.updateSubscription(lpSub.data.id, {
          nextPaymentOn: startOnDate.toISOString().replace(".000Z", "Z"),
        });
        if (fixed.data.nextPaymentOn) nextPaymentOn = new Date(fixed.data.nextPaymentOn);
      } catch {
        // Non-fatal — the clinic can reschedule.
      }
    }

    let created;
    try {
      created = await prisma.subscription.create({
        data: {
          clinicId: old.clinicId,
          customerId: old.customerId,
          paymentMethodId: pm.id,
          lunarpaySubscriptionId: lpSub.data.id,
          amountCents: totalCents,
          frequency: old.frequency,
          status: lpSub.data.status,
          startOn: lpSub.data.startOn ? new Date(lpSub.data.startOn) : startOnDate,
          nextPaymentOn,
          description: old.description,
          restartedFromId: old.id,
        },
      });
    } catch (dbErr) {
      // The subscription is live at LunarPay but unrecorded here. Undo it
      // rather than leave a billing subscription nothing in RevOS can see or
      // stop — an orphan would charge the patient every cycle forever.
      try {
        await lunarpay.cancelSubscription(lpSub.data.id);
        return NextResponse.json(
          { error: "Could not save the restart, so it was rolled back. Nothing was billed. Try again." },
          { status: 500 },
        );
      } catch {
        return NextResponse.json(
          {
            error:
              `Saved the subscription at the processor (id ${lpSub.data.id}) but could not record it here, ` +
              `and rolling it back also failed. Cancel ${lpSub.data.id} in LunarPay before retrying.`,
          },
          { status: 500 },
        );
      } finally {
        // eslint-disable-next-line no-console
        console.error("[subscription.restart] db write failed after LunarPay create", dbErr);
      }
    }

    await logAudit({
      actorId: guard.session.user.id ?? null,
      actorRole: guard.session.user.originalRole,
      clinicId: old.clinicId,
      action: "subscription.restart",
      targetType: "Subscription",
      targetId: created.id,
      metadata: {
        restartedFrom: old.id,
        previousLunarpaySubscriptionId: old.lunarpaySubscriptionId,
        baseCents,
        totalCents,
        frequency: old.frequency,
        startOn: parsed.data.startOn,
        paymentMethodId: pm.id,
      },
    });

    return NextResponse.json({ ok: true, data: { id: created.id } }, { status: 201 });
  } catch (e) {
    // Nothing was created (or it was rolled back), so drop the claim —
    // otherwise a transient LunarPay error would block this patient's restart
    // forever with no way to clear it from the UI.
    await prisma.subscriptionRestartClaim
      .deleteMany({ where: { restartedFromId: old.id } })
      .catch(() => null);
    const status = e instanceof LunarPayError ? e.status : 500;
    const msg = e instanceof Error ? e.message : "Restart failed.";
    return NextResponse.json({ error: msg }, { status });
  }
}
