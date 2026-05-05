import { NewCustomerForm } from "./form";

export default function NewCustomerPage() {
  return (
    <div className="max-w-2xl">
      <div className="card-pad">
        <h2 className="text-base font-semibold text-slate-900">Add customer</h2>
        <p className="text-sm text-slate-500 mt-1 mb-6">
          A LunarPay customer record will be created automatically under the
          shared merchant account.
        </p>
        <NewCustomerForm />
      </div>
    </div>
  );
}
