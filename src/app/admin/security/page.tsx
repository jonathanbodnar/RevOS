import { requireSuperAdmin } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { MfaClient } from "./mfa-client";

export const dynamic = "force-dynamic";

export default async function SecurityPage() {
  const session = await requireSuperAdmin();
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { mfaEnabled: true },
  });

  return (
    <div className="max-w-xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Security</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Two-factor authentication for your super-admin account.
        </p>
      </div>
      <MfaClient enabled={!!user?.mfaEnabled} />
    </div>
  );
}
