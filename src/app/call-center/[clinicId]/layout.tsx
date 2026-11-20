import { accessibleClinics, requireCallCenterClinicPage } from "@/lib/call-center/access";
import { PhoneProvider } from "@/components/call-center/phone-provider";
import { ClinicTabs } from "./clinic-tabs";

export const dynamic = "force-dynamic";

/** One clinic's call center: tabs plus a clinic switcher. Nothing here mixes clinics. */
export default async function ClinicCallCenterLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ clinicId: string }>;
}) {
  const { clinicId } = await params;
  const { session, clinic } = await requireCallCenterClinicPage(clinicId);
  const clinics = await accessibleClinics(session);
  // The phone line lives here so it survives switching tabs within the clinic.
  return (
    <PhoneProvider clinicId={clinic.id}>
      <div className="space-y-5">
        <ClinicTabs clinicId={clinic.id} clinicName={clinic.name} clinics={clinics.map((c) => ({ id: c.id, name: c.name }))} />
        {children}
      </div>
    </PhoneProvider>
  );
}
