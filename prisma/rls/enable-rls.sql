-- ============================================================================
-- Postgres Row-Level Security for RevOS — DEFENSE IN DEPTH behind app-code
-- tenant scoping. NOT auto-applied. Read the whole file, then validate on a
-- STAGING database before enabling in production.
--
-- WHY IT'S GATED: the app connects as one Postgres role, so RLS needs a
-- per-request clinic context set via a session GUC (app.current_clinic). If a
-- query runs WITHOUT that GUC set, these policies return ZERO rows — which will
-- break every page until the Prisma clinic-context extension
-- (src/lib/prisma-rls.ts) is wired in and proven. Enable in this order:
--   1. Wire src/lib/prisma-rls.ts into the Prisma client on staging.
--   2. Run this file on staging; exercise every role end-to-end.
--   3. Only then apply to production.
--
-- Super-admin / cron paths must set app.is_superuser = 'on' to bypass, since
-- they legitimately cross clinics.
-- ============================================================================

-- Helper: current clinic from the session GUC (NULL if unset).
CREATE OR REPLACE FUNCTION app_current_clinic() RETURNS text AS $$
  SELECT NULLIF(current_setting('app.current_clinic', true), '');
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION app_is_superuser() RETURNS boolean AS $$
  SELECT current_setting('app.is_superuser', true) = 'on';
$$ LANGUAGE sql STABLE;

-- Apply to every clinic-scoped table. Each policy: allow when super-user, or
-- when the row's clinicId matches the session clinic.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Customer','Charge','Subscription','PaymentSchedule','CheckoutSession',
    'CareCredit','AdvancedCost','ClinicPayout','InBodyTest','ChartWeek',
    'KPIFlag','CustomerProviderAssignment','AuditLog'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
      USING (app_is_superuser() OR "clinicId" = app_current_clinic())
      WITH CHECK (app_is_superuser() OR "clinicId" = app_current_clinic());
    $f$, t);
  END LOOP;
END $$;

-- To roll back:
--   DROP POLICY tenant_isolation ON "Customer";  (repeat per table)
--   ALTER TABLE "Customer" DISABLE ROW LEVEL SECURITY;  (repeat per table)
