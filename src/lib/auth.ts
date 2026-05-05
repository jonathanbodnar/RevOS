import type { NextAuthOptions, Session } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "./prisma";

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
      role: "SUPER_ADMIN" | "CLINIC_ADMIN";
      clinicId: string | null;
      // When a super-admin is impersonating, effectiveClinicId is set and
      // originalRole === "SUPER_ADMIN".
      effectiveClinicId: string | null;
      impersonating: boolean;
      originalRole: "SUPER_ADMIN" | "CLINIC_ADMIN";
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    uid?: string;
    role?: "SUPER_ADMIN" | "CLINIC_ADMIN";
    clinicId?: string | null;
    impersonatingClinicId?: string | null;
  }
}

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    CredentialsProvider({
      name: "Email + Password",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;
        const user = await prisma.user.findUnique({
          where: { email: credentials.email.toLowerCase().trim() },
        });
        if (!user || !user.isActive) return null;
        const ok = await bcrypt.compare(credentials.password, user.passwordHash);
        if (!ok) return null;
        return {
          id: user.id,
          email: user.email,
          name: user.name ?? undefined,
          role: user.role as "SUPER_ADMIN" | "CLINIC_ADMIN",
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
          role: "SUPER_ADMIN" | "CLINIC_ADMIN";
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
      const role = (token.role as "SUPER_ADMIN" | "CLINIC_ADMIN") || "CLINIC_ADMIN";
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
};

export async function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 10);
}
