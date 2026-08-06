import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getSession } from "@/lib/session";
import { logAudit } from "@/lib/audit";
import { securityAlert } from "@/lib/security-alert";
import { encryptField, decryptSecret } from "@/lib/encryption";
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
  // Write ONLY the pending secret — never touch a live mfaSecret/mfaEnabled.
  // Starting or abandoning enrollment therefore can't disable an active factor
  // (which would otherwise be a code-free MFA-downgrade path).
  await prisma.user.update({
    where: { id: session.user.id },
    data: { mfaPendingSecret: encryptField(secret) },
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
  if (!user?.mfaPendingSecret) {
    return NextResponse.json(
      { error: "Start enrollment first." },
      { status: 400 },
    );
  }
  // A pending secret that can't be read is a key problem, not a wrong code —
  // report it as such instead of sending the admin back to their app.
  let ok: boolean;
  try {
    ok = verifyTotp(decryptSecret(user.mfaPendingSecret, "MFA secret")!, parsed.data.code);
  } catch (e) {
    console.error("[mfa] enrollment secret unreadable:", e);
    return NextResponse.json(
      {
        error:
          "Server can't read the enrollment secret (encryption key problem). " +
          "Start setup again to generate a fresh one.",
      },
      { status: 500 },
    );
  }
  if (!ok) {
    return NextResponse.json({ error: "That code didn't match. Try again." }, { status: 400 });
  }
  // Promote the verified pending secret to the live factor.
  await prisma.user.update({
    where: { id: session.user.id },
    data: {
      mfaSecret: user!.mfaPendingSecret,
      mfaEnabled: true,
      mfaPendingSecret: null,
    },
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
  // If MFA is on, require a valid code to turn it off.
  if (user?.mfaEnabled) {
    let valid = false;
    try {
      valid =
        parsed.success &&
        verifyTotp(decryptSecret(user.mfaSecret, "MFA secret") ?? "", parsed.data.code);
    } catch (e) {
      // Unreadable secret: recovery is deliberately out-of-band. Waiving the
      // code here would make an unreadable secret an MFA-disable bypass.
      console.error("[mfa] live secret unreadable:", e);
      return NextResponse.json(
        {
          error:
            "Server can't read your MFA secret (encryption key problem), so it " +
            "can't verify a code. Reset it from the server with: " +
            "npx tsx scripts/reset-admin-password.ts <email> --clear-mfa",
        },
        { status: 500 },
      );
    }
    if (!valid) {
      return NextResponse.json(
        { error: "Enter a valid code to disable MFA." },
        { status: 400 },
      );
    }
  }
  await prisma.user.update({
    where: { id: session.user.id },
    data: { mfaEnabled: false, mfaSecret: null, mfaPendingSecret: null },
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
