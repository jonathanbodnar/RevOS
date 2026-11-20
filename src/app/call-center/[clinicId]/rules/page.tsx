import { requireCallCenterClinicPage, loadRules } from "@/lib/call-center/access";
import { RulesClient } from "./rules-client";

export const dynamic = "force-dynamic";

export default async function RulesPage({ params }: { params: Promise<{ clinicId: string }> }) {
  const { clinicId } = await params;
  const { clinic } = await requireCallCenterClinicPage(clinicId);
  const rules = await loadRules(clinic.id);
  return <RulesClient clinicId={clinic.id} clinicName={clinic.name} initial={rules} />;
}
