import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";

export default async function Home() {
  const session = await getSession();
  if (!session?.user) redirect("/login");
  if (session.user.originalRole === "SUPER_ADMIN") redirect("/admin");
  redirect("/clinic");
}
