import { headers } from "next/headers";
import { requireCallCenterClinicPage } from "@/lib/call-center/access";
import { listConnectLinks } from "@/lib/call-center/connect-link";
import { recentImports } from "@/lib/call-center/import-server";
import { integrationViews } from "@/lib/crm/integrations";
import { ImportFlow } from "@/components/call-center/import-flow";
import { ImportHistory } from "@/components/call-center/import-history";
import { CrmConnections } from "@/components/call-center/crm-connections";
import { ConnectLinkCard } from "@/components/call-center/connect-link-card";

export const dynamic = "force-dynamic";

/**
 * Import: bring a clinic's leads in from a spreadsheet or its CRM, and the
 * link the clinic can use to do it themselves.
 */
export default async function CallCenterImportPage({ params }: { params: Promise<{ clinicId: string }> }) {
  const { clinicId } = await params;
  const { clinic } = await requireCallCenterClinicPage(clinicId);

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  const origin = host ? `${h.get("x-forwarded-proto") ?? "https"}://${host}` : null;
  const [imports, integrations, links] = await Promise.all([
    recentImports(clinic.id),
    integrationViews(clinic.id),
    listConnectLinks(clinic.id, origin),
  ]);

  return (
    <div className="space-y-10 max-w-6xl">
      <section className="space-y-4">
        <div>
          <h2 className="text-xl font-semibold text-ink">Import leads</h2>
          <p className="text-sm text-ink-muted mt-0.5">
            Add {clinic.name}&apos;s leads from an Excel or CSV file. A phone number the clinic already has updates
            that lead instead of adding it twice.
          </p>
        </div>
        <ImportFlow mode="staff" endpoint={`/api/call-center/${clinic.id}/imports`} />
      </section>

      <section className="space-y-4">
        <div>
          <h3 className="section-title">Past imports</h3>
          <p className="section-subtitle">The last 20, newest first.</p>
        </div>
        <ImportHistory items={imports} />
      </section>

      <section className="space-y-4">
        <div>
          <h3 className="section-title">Clinic CRM</h3>
          <p className="section-subtitle">Connect {clinic.name}&apos;s CRM to pull leads in. Sync again any time.</p>
        </div>
        <CrmConnections mode="staff" base={`/api/call-center/${clinic.id}/integrations`} integrations={integrations} />
      </section>

      <section className="space-y-4">
        <div>
          <h3 className="section-title">Clinic link</h3>
          <p className="section-subtitle">Let the clinic connect its CRM or upload leads without a login.</p>
        </div>
        <ConnectLinkCard clinicId={clinic.id} links={links} />
      </section>
    </div>
  );
}
