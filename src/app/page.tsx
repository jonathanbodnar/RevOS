import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { homePathFor } from "@/lib/roles";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await getSession();
  if (!session?.user) redirect("/login");
  redirect(homePathFor(session.user.originalRole));
}
