"use client";

import { useState } from "react";
import { DEFAULT_RULES, EARLIEST_MINUTE, LATEST_MINUTE, type CallRulesConfig } from "@/lib/call-center/rules";
import { DAY_NAMES, US_TIMEZONES, minuteLabel } from "@/lib/call-center/time";

const WEEKDAYS = [1, 2, 3, 4, 5, 6];
const TIMES = Array.from({ length: (LATEST_MINUTE - EARLIEST_MINUTE) / 30 + 1 }, (_, i) => EARLIEST_MINUTE + i * 30);

/** This clinic's call rules. Defaults are the Dial Desk's; legal limits can't be loosened. */
export function RulesClient({ clinicId, clinicName, initial }: { clinicId: string; clinicName: string; initial: CallRulesConfig }) {
  const [r, setR] = useState<CallRulesConfig>(initial);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = <K extends keyof CallRulesConfig>(k: K, v: CallRulesConfig[K]) => setR((x) => ({ ...x, [k]: v }));
  const toggleDay = (k: "workDays" | "freshDays", d: number) =>
    set(k, r[k].includes(d) ? r[k].filter((x) => x !== d) : [...r[k], d].sort());

  async function save() {
    setSaving(true);
    setMsg(null);
    const res = await fetch(`/api/call-center/${clinicId}/rules`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(r),
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    setSaving(false);
    setMsg(res.ok ? { ok: true, text: "Saved. The list uses these rules now." } : { ok: false, text: body.error || "Couldn't save." });
  }

  const num = (k: keyof CallRulesConfig, label: string, help: string, min: number, max: number) => (
    <div>
      <label className="label">{label}</label>
      <input
        type="number"
        className="input"
        min={min}
        max={max}
        value={r[k] as number}
        onChange={(e) => set(k, Math.max(min, Math.min(max, Number(e.target.value) || 0)) as never)}
      />
      <p className="help-text">{help}</p>
    </div>
  );
  const check = (k: keyof CallRulesConfig, label: string, help?: string) => (
    <label className="flex items-start gap-3 text-sm text-ink">
      <input type="checkbox" className="mt-1" checked={r[k] as boolean} onChange={(e) => set(k, e.target.checked as never)} />
      <span>
        {label}
        {help && <span className="block text-xs text-ink-subtle mt-0.5">{help}</span>}
      </span>
    </label>
  );

  return (
    <div className="space-y-5 max-w-4xl">
      <div className="card-pad space-y-5">
        <div>
          <div className="section-title">When to call</div>
          <div className="section-subtitle">Clinic time for {clinicName}. Never on Sundays.</div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="label">Time zone</label>
            <select className="input" value={r.timezone} onChange={(e) => set("timezone", e.target.value)}>
              {US_TIMEZONES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">First call</label>
            <select className="input" value={r.callStartMinute} onChange={(e) => set("callStartMinute", Number(e.target.value))}>
              {TIMES.slice(0, -1).map((m) => (
                <option key={m} value={m}>
                  {minuteLabel(m)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">Last call before</label>
            <select className="input" value={r.callEndMinute} onChange={(e) => set("callEndMinute", Number(e.target.value))}>
              {TIMES.slice(1).map((m) => (
                <option key={m} value={m}>
                  {minuteLabel(m)}
                </option>
              ))}
            </select>
            <p className="help-text">Florida and Oklahoma allow 8 AM to 8 PM.</p>
          </div>
        </div>
        <div>
          <label className="label">Calling days</label>
          <div className="flex flex-wrap gap-2">
            {WEEKDAYS.map((d) => (
              <button key={d} type="button" onClick={() => toggleDay("workDays", d)} className={r.workDays.includes(d) ? "btn-primary !py-1.5" : "btn-secondary !py-1.5"}>
                {DAY_NAMES[d]}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="label">Days new leads get called</label>
          <div className="flex flex-wrap gap-2">
            {WEEKDAYS.map((d) => (
              <button key={d} type="button" onClick={() => toggleDay("freshDays", d)} className={r.freshDays.includes(d) ? "btn-primary !py-1.5" : "btn-secondary !py-1.5"}>
                {DAY_NAMES[d]}
              </button>
            ))}
          </div>
          <p className="help-text">Other days are for follow-ups, callbacks and confirmations only.</p>
        </div>
      </div>

      <div className="card-pad space-y-5">
        <div>
          <div className="section-title">How many tries</div>
          <div className="section-subtitle">What happens when nobody picks up.</div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {num("maxAttempts", "Tries before giving up", "Then they're marked unable to contact.", 1, 20)}
          {num("spacingDays", "Work days between tries", "0 means try again the next work day.", 0, 30)}
          {num("rebookAttempts", "Tries to rebook a cancel", "Then the clinic's front desk texts them.", 1, 10)}
          {num("maxCallsPer24h", "Most calls per person in 24 hours", "Florida and Oklahoma allow 3. A double-dial counts as 2.", 1, 10)}
          {num("recycleDays", "Put unreachable leads back after (days)", "0 means never.", 0, 365)}
          {num("ringSeconds", "Ring for (seconds)", "How long a call rings before it counts as no answer.", 10, 60)}
        </div>
        {check("doubleDial", "Double-dial", "If nobody answers, dial once more right away. Never leave a voicemail on these calls.")}
      </div>

      <div className="card-pad space-y-5">
        <div>
          <div className="section-title">Today&apos;s list</div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {num("dailyTarget", "Dials a day", "How many people go on each day's list.", 1, 2000)}
          {num("freshFloor", "New leads kept each new-lead day", "Even when follow-ups pile up.", 0, 2000)}
        </div>
        <div className="space-y-2">
          <div className="label">Appointment confirmation calls</div>
          {check("confirm48h", "48 hours before")}
          {check("confirm24h", "24 hours before")}
          {check("confirmDayOf", "The morning of")}
        </div>
      </div>

      <div className="card-pad space-y-4">
        <div>
          <div className="section-title">Auto-dial</div>
          <div className="section-subtitle">The dialer calls the list in order, one call at a time, so anyone who answers is put straight through.</div>
        </div>
        {check(
          "autoDialConsentOnly",
          "Only auto-dial leads with written consent on file",
          "Florida and Oklahoma require written consent for calls placed with an automated dialer. Leads without it can still be called one at a time.",
        )}
        {check("skipVoicemail", "Skip voicemails", "Detect answering machines and hang up instead of putting them through. Adds a second or two before people are connected.")}
      </div>

      <div className="flex items-center gap-3">
        <button className="btn-primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save rules"}
        </button>
        <button className="btn-ghost" onClick={() => setR({ ...DEFAULT_RULES, timezone: r.timezone })}>
          Reset to defaults
        </button>
        {msg && <span className={`text-sm ${msg.ok ? "text-emerald-700" : "text-red-700"}`}>{msg.text}</span>}
      </div>
    </div>
  );
}
