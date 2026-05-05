export default function PayCancel() {
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-slate-50">
      <div className="card-pad max-w-md w-full text-center">
        <h1 className="text-xl font-semibold text-slate-900">Payment cancelled</h1>
        <p className="text-sm text-slate-500 mt-1">
          No charge was made. You can close this window or try again.
        </p>
      </div>
    </div>
  );
}
