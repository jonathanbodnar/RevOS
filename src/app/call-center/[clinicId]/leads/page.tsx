import { loadRules, requireCallCenterClinicPage } from "@/lib/call-center/access";
import { LeadsClient } from "./leads-client";

export const dynamic = "force-dynamic";

export default async function LeadsPage({ params }: { params: Promise<{ clinicId: string }> }) {
  const { clinicId } = await params;
  const { clinic } = await requireCallCenterClinicPage(clinicId);
  const rules = await loadRules(clinic.id);
  return <LeadsClient clinicId={clinic.id} tz={rules.timezone} />;
}
