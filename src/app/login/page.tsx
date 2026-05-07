import Image from "next/image";
import { getSession } from "@/lib/session";
import { redirect } from "next/navigation";
import { LoginForm } from "./login-form";

export default async function LoginPage() {
  const session = await getSession();
  if (session?.user) {
    if (session.user.originalRole === "SUPER_ADMIN") redirect("/admin");
    redirect("/clinic");
  }
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-surface-base">
      <div className="w-full max-w-sm">
        <div className="text-center mb-7">
          <Image
            src="/logogrey.png"
            alt="RevOS"
            width={140}
            height={42}
            className="object-contain h-10 w-auto mx-auto"
            priority
          />
        </div>

        <div className="card-pad">
          <div className="text-center mb-6">
            <h1 className="text-lg font-semibold text-ink">
              Sign in to your account
            </h1>
            <p className="text-sm text-ink-muted mt-1">
              Manage clinics, customers, and payments.
            </p>
          </div>

          <LoginForm />
        </div>

        <p className="text-center text-[11px] text-ink-subtle mt-6">
          Privacy Policy · Terms of Use
        </p>
      </div>
    </div>
  );
}
