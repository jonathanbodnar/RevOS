/**
 * OPT-IN Prisma helper for Postgres RLS (see prisma/rls/enable-rls.sql).
 *
 * NOT wired into the default client yet — enabling RLS without proving this on
 * staging would make every query return zero rows. When you're ready:
 *   1. Apply prisma/rls/enable-rls.sql on staging.
 *   2. Route clinic-scoped requests through `withClinicContext`.
 *   3. Exercise all roles; then apply to production.
 *
 * Because the app uses a pooled connection, the GUC must be set inside the SAME
 * transaction as the queries — hence the interactive-transaction wrapper.
 */
import { prisma } from "./prisma";

/** Run `fn` with the clinic GUC set for RLS (clinic-scoped requests). */
export function withClinicContext<T>(
  clinicId: string,
  fn: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // set_config(name, value, is_local=true) → scoped to this transaction.
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.current_clinic', $1, true)`,
      clinicId,
    );
    return fn(tx);
  });
}

/** Run `fn` with the super-user bypass (admin/cron paths that cross clinics). */
export function withSuperuserContext<T>(
  fn: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.is_superuser', 'on', true)`);
    return fn(tx);
  });
}
