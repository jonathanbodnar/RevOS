import { requireSession } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { MfaSetup } from "@/components/mfa-setup";

export const dynamic = "force-dynamic";

export default async function AccountSecurityPage() {
  const session = await requireSession();
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { mfaEnabled: true },
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">
          Two-factor authentication
        </h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Protects your account if your password is ever guessed or leaked.
        </p>
      </div>
      <MfaSetup enabled={!!user?.mfaEnabled} />
    </div>
  );
}
