import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { logAudit } from "@/lib/audit";
import { securityAlert } from "@/lib/security-alert";
import { encryptField, decryptField } from "@/lib/encryption";
import { generateSecret, otpauthUri, verifyTotp } from "@/lib/totp";

export const dynamic = "force-dynamic";

/**
 * TOTP MFA enrollment for the signed-in super admin.
 *  POST   → start: generate a secret, return it + an otpauth URI to scan. Not
 *           yet enabled.
 *  PUT    → verify a code against the pending secret and enable MFA.
 *  DELETE → disable MFA (requires a valid current code).
 */
async function requireSuperAdmin() {
  const session = await getSession();
  if (session?.user?.originalRole !== "SUPER_ADMIN") return null;
  return session;
}

export async function POST() {
  const session = await requireSuperAdmin();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const secret = generateSecret();
  // Store the pending (encrypted) secret; mfaEnabled stays false until verified.
  await prisma.user.update({
    where: { id: session.user.id },
    data: { mfaSecret: encryptField(secret), mfaEnabled: false },
  });
  return NextResponse.json({
    data: { secret, otpauthUri: otpauthUri(secret, session.user.email) },
  });
}

const CodeBody = z.object({ code: z.string().trim().min(6).max(8) });

export async function PUT(req: Request) {
  const session = await requireSuperAdmin();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const parsed = CodeBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter the 6-digit code." }, { status: 400 });
  }
  const user = await prisma.user.findUnique({ where: { id: session.user.id } });
  const secret = decryptField(user?.mfaSecret);
  if (!secret) {
    return NextResponse.json(
      { error: "Start enrollment first." },
      { status: 400 },
    );
  }
  if (!verifyTotp(secret, parsed.data.code)) {
    return NextResponse.json({ error: "That code didn't match. Try again." }, { status: 400 });
  }
  await prisma.user.update({
    where: { id: session.user.id },
    data: { mfaEnabled: true },
  });
  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId: null,
    action: "mfa.enable",
    targetType: "User",
    targetId: session.user.id,
  });
  return NextResponse.json({ data: { enabled: true } });
}

export async function DELETE(req: Request) {
  const session = await requireSuperAdmin();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const parsed = CodeBody.safeParse(await req.json().catch(() => ({})));
  const user = await prisma.user.findUnique({ where: { id: session.user.id } });
  const secret = decryptField(user?.mfaSecret);
  // If MFA is on, require a valid code to turn it off.
  if (user?.mfaEnabled) {
    if (!parsed.success || !secret || !verifyTotp(secret, parsed.data.code)) {
      return NextResponse.json(
        { error: "Enter a valid code to disable MFA." },
        { status: 400 },
      );
    }
  }
  await prisma.user.update({
    where: { id: session.user.id },
    data: { mfaEnabled: false, mfaSecret: null },
  });
  await logAudit({
    actorId: session.user.id,
    actorRole: session.user.originalRole,
    clinicId: null,
    action: "mfa.disable",
    targetType: "User",
    targetId: session.user.id,
  });
  void securityAlert("mfa.disabled", { actorId: session.user.id });
  return NextResponse.json({ data: { enabled: false } });
}
