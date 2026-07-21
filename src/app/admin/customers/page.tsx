import { requireSuperAdmin } from "@/lib/session";
import { GlobalCustomerSearch } from "./customers-search";

export const dynamic = "force-dynamic";

export default async function AdminCustomersPage() {
  await requireSuperAdmin();
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold text-slate-900">Patients</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          Search every clinic. Opening a result switches you into that clinic
          and loads the patient profile.
        </p>
      </div>
      <GlobalCustomerSearch />
    </div>
  );
}
