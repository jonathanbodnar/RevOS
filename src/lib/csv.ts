/** Shared CSV helpers for table exports. */

export function csvEsc(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvMoney(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [headers.map(csvEsc).join(",")];
  for (const row of rows) {
    lines.push(row.map(csvEsc).join(","));
  }
  return lines.join("\n");
}

export type SchedulePaymentSnap = {
  amount: number;
  date: string;
  status?: string;
};

/** Parse PaymentSchedule.paymentsJson → dated payment list. */
export function parsePaymentsJson(
  raw: string | null | undefined,
): SchedulePaymentSnap[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: SchedulePaymentSnap[] = [];
    for (const p of parsed) {
      const item = p as { amount?: unknown; date?: unknown; status?: unknown };
      const amount =
        typeof item.amount === "number" ? item.amount : Number(item.amount);
      const date =
        typeof item.date === "string"
          ? item.date.slice(0, 10)
          : item.date != null
            ? String(item.date).slice(0, 10)
            : "";
      if (!date || !Number.isFinite(amount)) continue;
      out.push({
        amount,
        date,
        status: typeof item.status === "string" ? item.status : undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Next pending (or first) scheduled date from a payments snapshot. */
export function nextScheduledDate(payments: SchedulePaymentSnap[]): string | null {
  const pending = payments.find(
    (p) => !p.status || p.status === "pending" || p.status === "failed",
  );
  return (pending ?? payments[0])?.date ?? null;
}

/** Format YYYY-MM-DD for display without timezone shift. */
export function formatDateOnly(isoDate: string | null | undefined): string {
  if (!isoDate) return "—";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) return isoDate;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
