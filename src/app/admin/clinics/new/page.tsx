import { NewClinicForm } from "./form";

export default function NewClinicPage() {
  return (
    <div className="max-w-2xl">
      <div className="card-pad">
        <h2 className="text-base font-semibold text-slate-900">
          Create a new clinic
        </h2>
        <p className="text-sm text-slate-500 mt-1 mb-6">
          An initial clinic-admin user will be created and can sign in immediately.
        </p>
        <NewClinicForm />
      </div>
    </div>
  );
}
