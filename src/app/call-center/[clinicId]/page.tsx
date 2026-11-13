import { DeskClient } from "./desk-client";

export const dynamic = "force-dynamic";

/** Today: the desk. Access is checked by the layout (and again by every API call). */
export default async function TodayPage({
  params,
  searchParams,
}: {
  params: Promise<{ clinicId: string }>;
  searchParams: Promise<{ open?: string }>;
}) {
  const { clinicId } = await params;
  const { open } = await searchParams;
  return <DeskClient clinicId={clinicId} initialOpen={typeof open === "string" && /^[a-z0-9]{10,40}$/i.test(open) ? open : null} />;
}
