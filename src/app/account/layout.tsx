import Link from "next/link";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Personal account area — reachable by EVERY signed-in role (super admin,
 * clinic admin, provider, billing). Deliberately not inside the /admin or
 * /clinic shells: those gate on role, and account settings must not.
 */
export default async function AccountLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await requireSession();
  const backHref =
    session.user.originalRole === "SUPER_ADMIN" && !session.user.effectiveClinicId
      ? "/admin"
      : "/clinic";

  return (
    <div className="min-h-screen bg-surface-base">
      <header className="border-b border-line bg-white">
        <div className="max-w-3xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-ink tracking-tight">
              Your account
            </h1>
            <p className="text-xs text-ink-subtle mt-0.5">{session.user.email}</p>
          </div>
          <Link href={backHref} className="text-sm text-brand-600 hover:underline">
            ← Back
          </Link>
        </div>
      </header>
      <main className="max-w-3xl mx-auto px-6 py-8">{children}</main>
    </div>
  );
}
