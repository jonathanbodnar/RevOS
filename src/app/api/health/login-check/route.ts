import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

// Debug-only endpoint: confirms whether a given email/password would
// authenticate, without going through NextAuth.
// REMOVE BEFORE PRODUCTION USE.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
  };
  const email = body.email?.toLowerCase().trim();
  const password = body.password;
  if (!email || !password) {
    return NextResponse.json({ ok: false, reason: "missing email or password" });
  }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return NextResponse.json({
      ok: false,
      reason: "no user with that email",
      email,
    });
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  return NextResponse.json({
    ok,
    reason: ok ? "credentials valid" : "wrong password",
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
    },
    nextAuthUrl: process.env.NEXTAUTH_URL,
    hasNextAuthSecret: !!process.env.NEXTAUTH_SECRET,
  });
}
