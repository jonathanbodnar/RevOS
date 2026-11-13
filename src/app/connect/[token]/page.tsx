import type { Metadata } from "next";
import Image from "next/image";
import { findConnectLink, EXPIRED_MESSAGE, touchConnectLink } from "@/lib/call-center/connect-link";
import { integrationViews } from "@/lib/crm/integrations";
import { ImportFlow } from "@/components/call-center/import-flow";
import { CrmConnections } from "@/components/call-center/crm-connections";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Send your leads to RevOS",
  robots: { index: false, follow: false },
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-surface-base">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="flex justify-center mb-8">
          <Image src="/logogrey.png" alt="RevOS" width={120} height={40} className="h-9 w-auto object-contain" priority />
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * The clinic connect link: one page, no login, to connect the clinic's CRM
 * or upload a spreadsheet of leads. Shows the clinic its own connections and
 * counts of what it sent; never any lead or patient data from RevOS.
 */
export default async function ConnectPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const found = await findConnectLink(token);
  if (!found.ok) {
    return (
      <Shell>
        <div className="card-pad max-w-md mx-auto text-center">
          <h1 className="text-lg font-semibold text-ink">Link expired</h1>
          <p className="text-sm text-ink-muted mt-2">{EXPIRED_MESSAGE}</p>
        </div>
      </Shell>
    );
  }
  await touchConnectLink(found.link.id);
  const integrations = await integrationViews(found.clinic.id);
  const base = `/api/public/connect/${token}`;

  return (
    <Shell>
      <div className="text-center mb-10">
        <h1 className="text-2xl font-semibold text-ink tracking-tight">Send your leads to RevOS</h1>
        <p className="text-sm text-ink-muted mt-2">
          For {found.clinic.name}. Connect your CRM, or upload a spreadsheet. Either one is enough.
        </p>
      </div>

      <section className="space-y-4">
        <div>
          <h2 className="section-title">Connect your CRM</h2>
          <p className="section-subtitle">RevOS pulls your leads in and keeps them up to date.</p>
        </div>
        <CrmConnections mode="link" base={`${base}/integrations`} integrations={integrations} />
      </section>

      <section className="space-y-4 mt-12">
        <div>
          <h2 className="section-title">Upload a spreadsheet</h2>
          <p className="section-subtitle">
            An Excel or CSV export of your leads. Each one needs a phone number; names, emails and notes help.
          </p>
        </div>
        <ImportFlow mode="link" endpoint={`${base}/imports`} />
      </section>

      <p className="text-xs text-ink-subtle text-center mt-12">
        This page only sends information to RevOS. It never shows your leads or patients.
        {found.link.expiresAt
          ? ` The link works until ${found.link.expiresAt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}.`
          : ""}
      </p>
    </Shell>
  );
}
