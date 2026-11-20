import Link from "next/link";
import { requireCallCenterClinicPage } from "@/lib/call-center/access";
import { buildReport } from "@/lib/call-center/desk-server";
import { formatDateTime, formatDay } from "@/lib/call-center/time";
import { formatPhone } from "@/lib/phone";
import { CopyButton } from "@/components/copy-button";

export const dynamic = "force-dynamic";

/** The day's flash numbers (what used to go on the paper form) and the week so far. */
export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ clinicId: string }>;
  searchParams: Promise<{ day?: string }>;
}) {
  const { clinicId } = await params;
  const { day } = await searchParams;
  const { clinic } = await requireCallCenterClinicPage(clinicId);
  const r = await buildReport(clinic.id, new Date(), typeof day === "string" ? day : null);
  const s = r.stats;
  const flash = [
    `Daily flash · ${clinic.name} · ${formatDay(r.day)}`,
    `# of people called: ${s.people}`,
    `# of people talked to: ${s.talked}`,
    `# of consults booked: ${s.booked}${s.confirms ? ` + ${s.confirms} appt confirmations` : ""}`,
    `Total dials: ${s.dials} · Callbacks set: ${s.callbacks}`,
  ].join("\n");

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Link className="btn-secondary !py-1.5" href={`/call-center/${clinic.id}/report?day=${r.prevDay}`}>
          ← {formatDay(r.prevDay)}
        </Link>
        <div className="text-base font-semibold text-ink">{formatDay(r.day)}</div>
        {r.day !== r.today && (
          <Link className="btn-ghost !py-1.5" href={`/call-center/${clinic.id}/report`}>
            Today
          </Link>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-7 gap-3">
        {[
          ["Dials", s.dials],
          ["People called", s.people],
          ["Talked to", s.talked],
          ["Booked", s.booked],
          ["Confirmations", s.confirms],
          ["Callbacks set", s.callbacks],
          ["Talk time", `${r.talkMinutes} min`],
        ].map(([l, v]) => (
          <div key={l as string} className="card-pad !p-4">
            <div className={`text-2xl font-semibold tabular-nums ${l === "Booked" ? "text-emerald-700" : "text-ink"}`}>{v}</div>
            <div className="text-[11px] uppercase tracking-wider text-ink-subtle mt-1">{l}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="card-pad">
          <div className="section-header !mb-3">
            <div>
              <div className="section-title">Daily flash</div>
              <div className="section-subtitle">Copy this into Slack instead of the paper form.</div>
            </div>
            <CopyButton value={flash} />
          </div>
          <pre className="text-sm whitespace-pre-wrap bg-surface-base rounded-lg p-4 text-ink">{flash}</pre>
        </div>
        <div className="card overflow-hidden">
          <div className="px-6 pt-5 pb-3 section-title">Booked {r.day === r.today ? "today" : "this day"}</div>
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Phone</th>
                <th>Appointment</th>
              </tr>
            </thead>
            <tbody>
              {r.booked.length === 0 && (
                <tr>
                  <td colSpan={3} className="text-ink-muted">
                    No consults booked yet.
                  </td>
                </tr>
              )}
              {r.booked.map((b) => (
                <tr key={b.leadId + b.at}>
                  <td className="font-medium">{b.name}</td>
                  <td className="tabular-nums text-ink-muted">{formatPhone(b.phone)}</td>
                  <td>{formatDateTime(b.apptAt, r.timezone)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card overflow-hidden">
        <div className="px-6 pt-5 pb-3 section-title">This week</div>
        <table className="table">
          <thead>
            <tr>
              <th>Day</th>
              <th className="!text-right">Dials</th>
              <th className="!text-right">People called</th>
              <th className="!text-right">Talked to</th>
              <th className="!text-right">Booked</th>
              <th className="!text-right">Confirmations</th>
            </tr>
          </thead>
          <tbody>
            {r.week.map((w) => (
              <tr key={w.day}>
                <td>{formatDay(w.day)}</td>
                <td className="text-right tabular-nums">{w.dials}</td>
                <td className="text-right tabular-nums">{w.people}</td>
                <td className="text-right tabular-nums">{w.talked}</td>
                <td className="text-right tabular-nums">{w.booked}</td>
                <td className="text-right tabular-nums">{w.confirms}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="px-6 py-4 text-sm text-ink-muted border-t border-line">
          Week so far: {r.weekMarks.booked} booked · {r.weekMarks.confirmed} confirmed · {r.weekMarks.showed} showed ·{" "}
          {r.weekMarks.cancelled} cancelled · {r.weekMarks.noshow} no-shows
        </div>
      </div>
    </div>
  );
}
