import type { NextAuthOptions, Session } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";
import { logAudit } from "./audit";
import { securityAlert } from "./security-alert";
import { decryptField } from "./encryption";
import { verifyTotp } from "./totp";

// In-process failed-login counter, used only to ALERT on likely brute force —
// NOT to hard-lock the account. A hard per-email lock would let anyone who
// knows an admin's email deny them access, so instead correct credentials
// always authenticate and we merely alert on-call at the threshold. bcrypt's
// per-attempt cost is the throttle.
const LOGIN_FAILS = new Map<string, { n: number; resetAt: number }>();
const MAX_LOGIN_FAILS = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

function recordLoginFail(email: string): number {
  const now = Date.now();
  const cur = LOGIN_FAILS.get(email);
  if (!cur || now > cur.resetAt) {
    LOGIN_FAILS.set(email, { n: 1, resetAt: now + LOGIN_WINDOW_MS });
    return 1;
  }
  cur.n += 1;
  return cur.n;
}

/**
 * Session shape.
 *
 * A super-admin can "impersonate" a clinic. We store the clinicId they're
 * currently scoped to in the JWT so their view behaves like a clinic-admin
 * of that clinic, without losing the ability to step back out.
 */
declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string;
      name?: string | null;
      role: "SUPER_ADMIN" | "CLINIC_ADMIN" | "PROVIDER" | "BILLING_DEPT";
      clinicId: string | null;
      // When a super-admin is impersonating, effectiveClinicId is set and
      // originalRole === "SUPER_ADMIN".
      effectiveClinicId: string | null;
      impersonating: boolean;
      originalRole: "SUPER_ADMIN" | "CLINIC_ADMIN" | "PROVIDER" | "BILLING_DEPT";
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid?: string;
    role?: "SUPER_ADMIN" | "CLINIC_ADMIN" | "PROVIDER" | "BILLING_DEPT";
    clinicId?: string | null;
    impersonatingClinicId?: string | null;
  }
}

export const authOptions: NextAuthOptions = {
  // 8-hour sessions (was the 30-day default) with a daily rolling refresh —
  // a stolen token expires the same workday rather than a month later.
  session: { strategy: "jwt", maxAge: 8 * 60 * 60, updateAge: 24 * 60 * 60 },
  pages: { signIn: "/login" },
  providers: [
    CredentialsProvider({
      name: "Email + Password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
        totp: { label: "Authenticator code", type: "text" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;
        const email = credentials.email.toLowerCase().trim();
        const user = await prisma.user.findUnique({ where: { email } });
        // Don't count unknown/inactive emails — that would let an attacker
        // trip alerts (and, previously, lock out) arbitrary addresses.
        if (!user || !user.isActive) return null;
        const ok = await bcrypt.compare(credentials.password, user.passwordHash);
        if (!ok) {
          const n = recordLoginFail(email);
          if (n === MAX_LOGIN_FAILS) {
            // Hit the threshold — alert on-call (correct creds still work).
            void securityAlert("auth.repeated_failures", {
              email,
              failures: n,
              windowMinutes: LOGIN_WINDOW_MS / 60000,
            });
          }
          return null;
        }
        // Second factor — ONLY enforced when the user has finished enrollment,
        // so anyone without MFA logs in unchanged. Defensive: a decrypt/verify
        // error fails closed for that MFA user, never for others.
        if (user.mfaEnabled && user.mfaSecret) {
          try {
            const secret = decryptField(user.mfaSecret);
            if (!secret || !verifyTotp(secret, String(credentials.totp ?? ""))) {
              recordLoginFail(email);
              return null;
            }
          } catch {
            return null;
          }
        }
        LOGIN_FAILS.delete(email); // success resets the counter
        return {
          id: user.id,
          email: user.email,
          name: user.name ?? undefined,
          role: user.role as "SUPER_ADMIN" | "CLINIC_ADMIN" | "PROVIDER" | "BILLING_DEPT",
          clinicId: user.clinicId,
        } as never;
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger, session }) {
      if (user) {
        const u = user as unknown as {
          id: string;
          role: "SUPER_ADMIN" | "CLINIC_ADMIN" | "PROVIDER" | "BILLING_DEPT";
          clinicId: string | null;
        };
        token.uid = u.id;
        token.role = u.role;
        token.clinicId = u.clinicId;
        token.impersonatingClinicId = null;
      }
      // Allow the client to call `update({ impersonatingClinicId })`.
      if (trigger === "update" && session) {
        if ("impersonatingClinicId" in session) {
          token.impersonatingClinicId =
            (session as { impersonatingClinicId?: string | null })
              .impersonatingClinicId ?? null;
        }
      }
      return token;
    },
    async session({ session, token }): Promise<Session> {
      const role = (token.role as "SUPER_ADMIN" | "CLINIC_ADMIN" | "PROVIDER" | "BILLING_DEPT") || "CLINIC_ADMIN";
      const ownClinicId = (token.clinicId as string | null) ?? null;
      const impersonating =
        role === "SUPER_ADMIN" && !!token.impersonatingClinicId;
      session.user = {
        id: (token.uid as string) || "",
        email: session.user?.email || "",
        name: session.user?.name,
        role,
        clinicId: ownClinicId,
        effectiveClinicId: impersonating
          ? (token.impersonatingClinicId as string)
          : ownClinicId,
        impersonating,
        originalRole: role,
      };
      return session;
    },
  },
  events: {
    async signIn({ user }) {
      await logAudit({
        actorId: (user as { id?: string })?.id ?? null,
        actorRole: (user as { role?: string })?.role ?? null,
        clinicId: (user as { clinicId?: string | null })?.clinicId ?? null,
        action: "auth.login",
        targetType: "User",
        targetId: (user as { id?: string })?.id ?? null,
      });
    },
    async signOut({ token }) {
      await logAudit({
        actorId: (token?.uid as string) ?? null,
        actorRole: (token?.role as string) ?? null,
        action: "auth.logout",
        targetType: "User",
        targetId: (token?.uid as string) ?? null,
      });
    },
  },
};

export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 10);
}
