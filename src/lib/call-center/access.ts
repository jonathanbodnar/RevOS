/**
 * Who may use the call center, and for which clinics.
 *
 *  - SUPER_ADMIN: every active clinic, plus phone setup (buying numbers spends
 *    money, so it stays super-admin only).
 *  - CALL_AGENT: only the clinics listed in CallCenterAccess.
 *  - Everyone else: no call center.
 *
 * Pages use the `require…Page` helpers (redirect / 404); route handlers use the
 * `require…Api` helpers (401 / 403 / 404 JSON). Path params are validated with
 * requireStringParams before any of these run.
 */
import { NextResponse } from "next/server";
import { notFound, redirect } from "next/navigation";
import { prisma } from "../prisma";
import { getSession } from "../session";
import { rulesFromRow, type CallRulesConfig } from "./rules";
import { timezoneForState } from "./time";

type AnySession = NonNullable<Awaited<ReturnType<typeof getSession>>>;

export function canUseCallCenter(role: string | undefined | null): boolean {
  return role === "SUPER_ADMIN" || role === "CALL_AGENT";
}

export type CallCenterClinic = { id: string; name: string; state: string | null };

/** Active clinics this session may work, by name. */
export async function accessibleClinics(session: AnySession): Promise<CallCenterClinic[]> {
  const role = session.user.originalRole;
  if (role === "SUPER_ADMIN") {
    return prisma.clinic.findMany({
      where: { isActive: true },
      select: { id: true, name: true, state: true },
      orderBy: { name: "asc" },
    });
  }
  if (role === "CALL_AGENT") {
    const rows = await prisma.callCenterAccess.findMany({
      where: { userId: session.user.id, clinic: { isActive: true } },
      select: { clinic: { select: { id: true, name: true, state: true } } },
    });
    return rows.map((r) => r.clinic).sort((a, b) => a.name.localeCompare(b.name));
  }
  return [];
}

async function mayAccessClinic(session: AnySession, clinicId: string): Promise<boolean> {
  const role = session.user.originalRole;
  if (role === "SUPER_ADMIN") return true;
  if (role !== "CALL_AGENT") return false;
  const row = await prisma.callCenterAccess.findUnique({
    where: { userId_clinicId: { userId: session.user.id, clinicId } },
    select: { clinicId: true },
  });
  return !!row;
}

/** Page guard for /call-center. */
export async function requireCallCenterPage(): Promise<AnySession> {
  const session = await getSession();
  if (!session?.user) redirect("/login");
  if (!canUseCallCenter(session.user.originalRole)) redirect("/");
  return session;
}

/** Page guard for /call-center/[clinicId]/… — 404s clinics the agent can't work. */
export async function requireCallCenterClinicPage(clinicId: string) {
  const session = await requireCallCenterPage();
  if (typeof clinicId !== "string" || !clinicId) notFound();
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { id: true, name: true, state: true, isActive: true },
  });
  if (!clinic || !clinic.isActive || !(await mayAccessClinic(session, clinicId))) notFound();
  return { session, clinic };
}

type ApiOk = { session: AnySession; clinicId: string };
type ApiErr = { error: NextResponse };

/** Route guard: signed in, call-center role, and allowed on this clinic. */
export async function requireCallCenterApi(clinicId: string): Promise<ApiOk | ApiErr> {
  const session = await getSession();
  if (!session?.user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (!canUseCallCenter(session.user.originalRole)) {
    return { error: NextResponse.json({ error: "Call center access only." }, { status: 403 }) };
  }
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    select: { id: true, isActive: true },
  });
  // 404 (not 403) for clinics outside the agent's list, so ids don't leak.
  if (!clinic || !clinic.isActive || !(await mayAccessClinic(session, clinicId))) {
    return { error: NextResponse.json({ error: "Clinic not found" }, { status: 404 }) };
  }
  return { session, clinicId };
}

/** Route guard: signed in with a call-center role (no clinic yet). */
export async function requireCallCenterUserApi(): Promise<{ session: AnySession } | ApiErr> {
  const session = await getSession();
  if (!session?.user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (!canUseCallCenter(session.user.originalRole)) {
    return { error: NextResponse.json({ error: "Call center access only." }, { status: 403 }) };
  }
  return { session };
}

/** Route guard for phone setup and number purchases. */
export async function requireCallCenterAdminApi(): Promise<{ session: AnySession } | ApiErr> {
  const session = await getSession();
  if (!session?.user) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (session.user.originalRole !== "SUPER_ADMIN") {
    return { error: NextResponse.json({ error: "Only super admins can change phone setup." }, { status: 403 }) };
  }
  return { session };
}

/** The clinic's rules, falling back to defaults (time zone from its state). */
export async function loadRules(clinicId: string): Promise<CallRulesConfig> {
  const row = await prisma.callRules.findUnique({ where: { clinicId } });
  if (row) return rulesFromRow(row);
  const clinic = await prisma.clinic.findUnique({ where: { id: clinicId }, select: { state: true } });
  return { ...rulesFromRow(null), timezone: timezoneForState(clinic?.state) };
}
