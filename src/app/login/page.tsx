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
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-brand-600 text-white font-bold text-lg mb-3">
            R
          </div>
          <h1 className="text-2xl font-semibold text-slate-900">RevOS</h1>
          <p className="text-sm text-slate-500 mt-1">
            Sign in to your account
          </p>
        </div>
        <div className="card-pad">
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
