import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Two-factor setup moved to /account/security, which every role can reach —
 * this page was super-admin-only, so nobody else could enroll at all. Kept as
 * a redirect so existing links and bookmarks still land somewhere useful.
 */
export default async function SecurityPage() {
  redirect("/account/security");
}
