import { LeadsClient } from "./leads-client";

export const dynamic = "force-dynamic";

export default async function LeadsPage({ params }: { params: Promise<{ clinicId: string }> }) {
  const { clinicId } = await params;
  return <LeadsClient clinicId={clinicId} />;
}
