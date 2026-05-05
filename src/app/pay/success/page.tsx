export default function PaySuccess() {
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
      <div className="card-pad max-w-md w-full text-center">
        <div className="text-4xl mb-3">✓</div>
        <h1 className="text-xl font-semibold text-slate-900">Payment received</h1>
        <p className="text-sm text-slate-500 mt-1">
          Thank you — a receipt will be emailed to you shortly.
        </p>
      </div>
    </div>
  );
}
