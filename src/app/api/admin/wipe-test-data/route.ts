import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { logAudit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * Wipe all transactional test data — customers, charges, subscriptions,
 * payment schedules, payment methods, and payment links — while keeping
 * clinics and users intact.
 *
 * Super admin only. Requires a confirmation token in the body:
 *   { "confirm": "WIPE" }
 */
export async function POST(req: Request) {
  const session = await getSession();
  if (session?.user?.originalRole !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { confirm?: string };
  if (body.confirm !== "WIPE") {
    return NextResponse.json(
      { error: 'Send { "confirm": "WIPE" } to proceed.' },
      { status: 400 },
    );
  }

  // Delete in dependency order so FK constraints don't fire.
  // Customers cascade-delete their payment methods, charges, subscriptions
  // and schedules via Prisma's onDelete: Cascade. We also wipe checkout
  // sessions (payment links) separately since they have no customer FK.
  const [
    deletedSchedules,
    deletedSubs,
    deletedCharges,
    deletedPMs,
    deletedCustomers,
    deletedLinks,
  ] = await prisma.$transaction([
    prisma.paymentSchedule.deleteMany({}),
    prisma.subscription.deleteMany({}),
    prisma.charge.deleteMany({}),
    prisma.paymentMethod.deleteMany({}),
    prisma.customer.deleteMany({}),
    prisma.checkoutSession.deleteMany({}),
  ]);

  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId: null,
    action: "admin.wipe_test_data",
    targetType: null,
    targetId: null,
    metadata: {
      deletedCustomers: deletedCustomers.count,
      deletedCharges: deletedCharges.count,
      deletedSubscriptions: deletedSubs.count,
      deletedSchedules: deletedSchedules.count,
      deletedPaymentMethods: deletedPMs.count,
      deletedPaymentLinks: deletedLinks.count,
    },
  });

  return NextResponse.json({
    ok: true,
    deleted: {
      customers: deletedCustomers.count,
      charges: deletedCharges.count,
      subscriptions: deletedSubs.count,
      schedules: deletedSchedules.count,
      paymentMethods: deletedPMs.count,
      paymentLinks: deletedLinks.count,
    },
  });
}
