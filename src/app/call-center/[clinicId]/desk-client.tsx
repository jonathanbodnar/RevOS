"use client";

/**
 * The Today screen: the Dial Desk inside RevOS, for one clinic.
 * Left: today's list by section. Right: the person to call now, the outcome
 * buttons (with the Dial Desk's keyboard shortcuts), notes and history.
 * Top: the browser phone (go live, auto-dial, hang up) and the day's tally.
 * Without phone setup it still works the old way: dial from your own phone,
 * log each result here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePhone, type DialerState as Dialer } from "@/components/call-center/phone-provider";
import { formatPhone } from "@/lib/phone";
import type { CallRulesConfig } from "@/lib/call-center/rules";
import { checkCallingHours, hoursLabel } from "@/lib/call-center/rules";
import {
  KIND_LABEL,
  NEEDS_WHEN,
  OUTCOME_LABEL,
  STAGE_BADGE,
  STAGE_LABEL,
  STAGES,
  TOUCH_LABEL,
  isStage,
  outcomeSetFor,
  type CallOutcome,
  type ItemKind,
  type QueueKind,
  type Stage,
  type Touch,
} from "@/lib/call-center/stages";
import {
  DAY_NAMES,
  addDays,
  addWorkDays,
  dayInTz,
  dow,
  formatDateTime,
  formatDay,
  isWorkDay,
  localInputValue,
  minutesInTz,
  nextWorkDay,
} from "@/lib/call-center/time";

type Item = { leadId: string; kind: QueueKind; touch?: Touch; done: boolean; claimedByOther: boolean };
type Section = { kind: QueueKind; items: Item[]; done: number; total: number };
type Summary = {
  id: string;
  name: string;
  phone: string;
  stage: string;
  priority: boolean;
  attempts: number;
  callbackAt: string | null;
  apptAt: string | null;
  lastCalledAt: string | null;
  lastAttemptDay: string | null;
};
type History = { at: string; kind: string; outcome: string; touch: string | null; scheduledAt: string | null; note: string | null };
type Detail = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  stage: string;
  priority: boolean;
  lostReason: string | null;
  attempts: number;
  lastCalledAt: string | null;
  callbackAt: string | null;
  apptAt: string | null;
  lastNote: string | null;
  consent: boolean;
  source: string | null;
  sourceStatus: string | null;
  customer: { id: string; name: string } | null;
  callsLast24h: number;
  history: History[];
};
type Desk = {
  day: string;
  rules: CallRulesConfig;
  plan: { off: boolean; offReason?: string; sections: Section[]; total: number; done: number; held: number; freshToday: number };
  leads: Record<string, Summary>;
  current: { leadId: string; kind: ItemKind; touch?: Touch } | null;
  detail: Detail | null;
  stats: { dials: number; people: number; talked: number; booked: number; confirms: number; callbacks: number };
  newLeft: number;
};

const pad = (n: number) => String(n).padStart(2, "0");
const TONE: Record<string, string> = {
  "": "border-line bg-white text-ink hover:bg-surface-base",
  good: "border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100",
  gold: "border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100",
  bad: "border-red-100 bg-white text-red-700 hover:bg-red-50",
};
const SECTION_DOT: Record<QueueKind, string> = {
  callback: "bg-amber-400",
  confirm: "bg-emerald-500",
  resched: "bg-orange-400",
  cycle: "bg-sky-400",
  fresh: "bg-neutral-400",
};
const HANGUP_LABEL: Record<string, string> = {
  timeout: "No answer",
  no_answer: "No answer",
  user_busy: "Busy",
  call_rejected: "Declined",
  not_found: "Number not in service",
  originator_cancel: "Hung up before answer",
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers || {}) }, cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as { data?: T; error?: string };
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body.data as T;
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

export function DeskClient({ clinicId, initialOpen }: { clinicId: string; initialOpen?: string | null }) {
  const base = `/api/call-center/${clinicId}`;
  const [desk, setDesk] = useState<Desk | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ leadId: string } | null>(initialOpen ? { leadId: initialOpen } : null);
  const [redialPin, setRedialPin] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [prompt, setPrompt] = useState<{ outcome: CallOutcome; value: string; err?: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const phone = usePhone();
  const dialer = phone.dialer;
  const loadDialer = phone.refresh;
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Summary[] | null>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const lastLeadRef = useRef<string | null>(null);
  const followRef = useRef<string | null>(null);
  const now = useClock();

  const flash = useCallback((m: string) => {
    if (!m) return;
    setToast(m);
    window.setTimeout(() => setToast((t) => (t === m ? null : t)), 4500);
  }, []);

  const loadDesk = useCallback(
    async (focusId?: string | null, focusKind?: "inbound") => {
      try {
        const qs = focusId ? `?focus=${encodeURIComponent(focusId)}${focusKind ? `&kind=${focusKind}` : ""}` : "";
        const d = await api<Desk>(`${base}/desk${qs}`);
        setDesk(d);
        setLoadError(null);
        const id = d.current?.leadId ?? null;
        if (id !== lastLeadRef.current) {
          lastLeadRef.current = id;
          setNote("");
          setPrompt(null);
        }
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : "Couldn't load the desk.");
      }
    },
    [base],
  );

  useEffect(() => {
    void loadDesk(initialOpen ?? null);
  }, [loadDesk, initialOpen]);

  const session = dialer?.session ?? null;
  const live = phone.live;

  // The auto dialer (or a patient calling in) picks who's on the card.
  useEffect(() => {
    const lid = session?.lead?.id ?? null;
    if (lid && lid !== followRef.current && (session?.mode === "auto" || session?.call?.direction === "inbound")) {
      followRef.current = lid;
      setFocus({ leadId: lid });
      void loadDesk(lid, session?.call?.direction === "inbound" ? "inbound" : undefined);
    }
    if (!lid) followRef.current = null;
  }, [session?.lead?.id, session?.mode, session?.call?.direction, loadDesk]);

  const rules = desk?.rules;
  const tz = rules?.timezone ?? "America/Chicago";
  const current = desk?.current ?? null;
  const detail = desk?.detail ?? null;
  const hours = rules ? checkCallingHours(now, rules) : { ok: true as const };
  const onThisCall = !!session && !!current && session.lead?.id === current.leadId && !!session.call;
  const callStatus = onThisCall ? session!.status : null;

  const order = useMemo(() => (desk ? desk.plan.sections.flatMap((s) => s.items) : []), [desk]);
  const pos = current ? order.findIndex((i) => i.leadId === current.leadId && !i.done) + 1 : 0;

  // ── actions ───────────────────────────────────────────────────────────────
  async function goLive(mode: "manual" | "auto") {
    const err = await phone.goLive(mode);
    if (err) flash(err);
  }
  async function dialerAction(action: "auto" | "pause" | "hangup") {
    const err = await phone.action(action);
    if (err) flash(err);
  }
  async function dial() {
    if (!current) return;
    try {
      await api(`${base}/dialer`, {
        method: "POST",
        body: JSON.stringify({ action: "dial", leadId: current.leadId, kind: current.kind, touch: current.touch ?? null, redial: redialPin === current.leadId }),
      });
    } catch (e) {
      flash(e instanceof Error ? e.message : "Couldn't place the call.");
    }
    void loadDialer();
  }

  async function logOutcome(outcome: CallOutcome, scheduledLocal?: string) {
    if (!current || busy) return;
    if (NEEDS_WHEN.has(outcome) && !scheduledLocal) {
      setPrompt({ outcome, value: defaultWhen(outcome) });
      return;
    }
    if (outcome === "note" && !note.trim()) {
      flash("Type a note first.");
      noteRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ message: string; advance: boolean; redialNext: boolean }>(`${base}/leads/${current.leadId}/outcome`, {
        method: "POST",
        body: JSON.stringify({
          kind: current.kind,
          touch: current.touch ?? null,
          outcome,
          note: note.trim() || null,
          scheduledLocal: scheduledLocal ?? null,
          redial: redialPin === current.leadId,
          callId: onThisCall ? session!.call!.id : null,
        }),
      });
      setPrompt(null);
      if (r.redialNext) {
        setRedialPin(current.leadId);
        setFocus({ leadId: current.leadId });
        setNote("");
        await loadDesk(current.leadId);
      } else {
        setRedialPin(null);
        if (outcome !== "note") {
          setFocus(null);
          setNote("");
          await loadDesk(null);
        } else {
          setNote("");
          await loadDesk(current.leadId);
        }
      }
      flash(r.message);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Couldn't save that.");
    } finally {
      setBusy(false);
      void loadDialer();
    }
  }

  async function update(body: Record<string, unknown>) {
    if (!current) return;
    try {
      const r = await api<{ message: string }>(`${base}/leads/${current.leadId}/update`, { method: "POST", body: JSON.stringify(body) });
      flash(r.message);
      await loadDesk(focus?.leadId ?? current.leadId);
    } catch (e) {
      flash(e instanceof Error ? e.message : "Couldn't update.");
    }
  }
  async function skip() {
    if (!current) return;
    await api(`${base}/leads/${current.leadId}/skip`, { method: "POST" }).catch(() => {});
    setFocus(null);
    setRedialPin(null);
    await loadDesk(null);
  }
  async function addMore() {
    await api(`${base}/more`, { method: "POST" }).catch(() => {});
    flash("Added 25 new leads to today's list.");
    await loadDesk(focus?.leadId ?? null);
  }
  function open(leadId: string) {
    setFocus({ leadId });
    setRedialPin(null);
    setResults(null);
    setQ("");
    void loadDesk(leadId);
    window.scrollTo({ top: 0 });
  }
  function backToList() {
    setFocus(null);
    setRedialPin(null);
    void loadDesk(null);
  }

  function defaultWhen(outcome: CallOutcome): string {
    if (!rules) return "";
    if (outcome === "resch" && detail?.apptAt) return localInputValue(new Date(detail.apptAt), tz);
    if (outcome === "cb") return "";
    const day = nextWorkDay(dayInTz(new Date(), tz), rules.workDays);
    return `${day}T10:00`;
  }

  function chips(): [string, string][] {
    if (!prompt || prompt.outcome !== "cb" || !rules) return [];
    const t = new Date();
    const today = dayInTz(t, tz);
    const at = (day: string, h: number, m = 0) => `${day}T${pad(h)}:${pad(m)}`;
    const out: [string, string][] = [];
    const nowMin = minutesInTz(t, tz);
    const inHour = Math.ceil((nowMin + 60) / 15) * 15;
    const workToday = isWorkDay(today, rules.workDays);
    if (workToday && inHour >= rules.callStartMinute && inHour < rules.callEndMinute) out.push(["In an hour", at(today, Math.floor(inHour / 60), inHour % 60)]);
    if (workToday && nowMin < 17 * 60 && 17 * 60 < rules.callEndMinute) out.push(["Today 5 PM", at(today, 17)]);
    const nw = nextWorkDay(today, rules.workDays);
    out.push([`${DAY_NAMES[dow(nw)]} 10 AM`, at(nw, 10)], [`${DAY_NAMES[dow(nw)]} 5 PM`, at(nw, 17)]);
    const w2 = addWorkDays(today, 2, rules.workDays);
    out.push([`${DAY_NAMES[dow(w2)]} 10 AM`, at(w2, 10)]);
    let wk = addDays(today, 7);
    while (!isWorkDay(wk, rules.workDays)) wk = addDays(wk, 1);
    out.push(["In a week", at(wk, 10)]);
    return out;
  }

  // Search (find a name or number).
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults(null);
      return;
    }
    const t = window.setTimeout(async () => {
      try {
        const r = await api<{ rows: Summary[] }>(`${base}/leads?q=${encodeURIComponent(term)}`);
        setResults(r.rows.slice(0, 8));
      } catch {
        setResults([]);
      }
    }, 250);
    return () => window.clearTimeout(t);
  }, [q, base]);

  // Keyboard shortcuts, as on the Dial Desk.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!current || prompt) return;
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      const set = outcomeSetFor(current.kind);
      if (typing) {
        if (e.altKey && el === noteRef.current) {
          const b = set.find((x) => x.key === e.key);
          if (b) {
            e.preventDefault();
            void logOutcome(b.outcome);
          }
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const b = set.find((x) => x.key === e.key);
      if (b) {
        e.preventDefault();
        void logOutcome(b.outcome);
      } else if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        void skip();
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        noteRef.current?.focus();
      } else if (e.key === "c" || e.key === "C") {
        e.preventDefault();
        if (detail) void navigator.clipboard?.writeText(formatPhone(detail.phone)).then(() => flash("Number copied."));
      } else if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (loadError && !desk) return <div className="card-pad text-sm text-red-700">{loadError}</div>;
  if (!desk || !rules) return <div className="card-pad text-sm text-ink-muted">Loading today&apos;s list…</div>;

  const s = desk.stats;
  const progress = desk.plan.total ? Math.round((desk.plan.done / desk.plan.total) * 100) : 0;

  return (
    <div className="space-y-4">
      {/* Tally + goal, like the Dial Desk header */}
      <div className="card px-5 py-4 flex flex-wrap items-center gap-x-8 gap-y-3">
        {[
          ["Dials", s.dials],
          ["People called", s.people],
          ["Talked to", s.talked],
          ["Booked", s.booked],
          ["Confirmations", s.confirms],
          ["Callbacks set", s.callbacks],
        ].map(([label, v]) => (
          <div key={label as string}>
            <div className={`text-xl font-semibold tabular-nums ${label === "Booked" ? "text-emerald-700" : "text-ink"}`}>{v}</div>
            <div className="text-[10px] uppercase tracking-wider text-ink-subtle">{label}</div>
          </div>
        ))}
        <div className="flex-1 min-w-[180px]">
          <div className="flex justify-between text-xs text-ink-muted mb-1">
            <span>{desk.plan.off ? "No list today" : "Today's list"}</span>
            <span className="tabular-nums">{desk.plan.total ? `${desk.plan.done} of ${desk.plan.total}` : ""}</span>
          </div>
          <div className="h-1.5 rounded-full bg-surface-alt overflow-hidden">
            <div className="h-full bg-brand-900 transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>
        <div className="text-sm text-ink-muted tabular-nums" title="Clinic time">
          {now.toLocaleString("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "2-digit" })}
        </div>
      </div>

      <PhoneBar
        dialer={dialer}
        phoneStatus={phone.phoneStatus}
        phoneError={phone.phoneError}
        muted={phone.muted}
        busy={busy || phone.busy}
        onLive={() => goLive("manual")}
        onAuto={() => dialerAction("auto")}
        onPause={() => dialerAction("pause")}
        onHangup={() => dialerAction("hangup")}
        onEnd={phone.endLive}
        onMute={phone.toggleMute}
        now={now}
      />

      {!hours.ok && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <b className="font-semibold">Outside calling hours.</b> {hours.reason}
        </div>
      )}
      {loadError && <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700">{loadError}</div>}

      <div className="relative">
        <input
          ref={searchRef}
          className="input"
          placeholder="Find a name or number  ( / )"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Find a lead"
        />
        {results && (
          <div className="absolute z-10 mt-1 w-full card shadow-sm overflow-hidden">
            {results.length === 0 ? (
              <div className="px-4 py-3 text-sm text-ink-muted">No one matches.</div>
            ) : (
              results.map((r) => (
                <button key={r.id} onClick={() => open(r.id)} className="w-full text-left px-4 py-2.5 hover:bg-surface-base flex justify-between gap-3 text-sm">
                  <span className="font-medium text-ink">{r.name}</span>
                  <span className="text-ink-muted tabular-nums">{formatPhone(r.phone)}</span>
                  <span className={isStage(r.stage) ? STAGE_BADGE[r.stage] : "badge-slate"}>{isStage(r.stage) ? STAGE_LABEL[r.stage] : r.stage}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)] gap-5 items-start">
        <Queue desk={desk} current={current} tz={tz} onOpen={open} onMore={addMore} onRefresh={() => loadDesk(focus?.leadId ?? null)} />
        <div>
          {!current || !detail ? (
            <div className="card-pad text-center py-14">
              <h2 className="text-xl font-semibold text-ink">{desk.plan.off ? "Day off" : "List done"}</h2>
              <p className="text-sm text-ink-muted mt-2">
                {desk.plan.off ? desk.plan.offReason : `${s.dials} dials today, ${s.booked} booked.`}
                {!desk.plan.off && desk.newLeft > 0 ? " Add more new leads to keep going." : ""}
              </p>
              {!desk.plan.off && desk.newLeft > 0 && (
                <button className="btn-primary mt-5" onClick={addMore}>
                  Add 25 new leads
                </button>
              )}
            </div>
          ) : (
            <Card
              desk={desk}
              current={current}
              detail={detail}
              pos={pos}
              total={order.length}
              tz={tz}
              note={note}
              setNote={setNote}
              noteRef={noteRef}
              prompt={prompt}
              setPrompt={setPrompt}
              chips={chips()}
              redial={redialPin === current.leadId}
              hoursOk={hours.ok}
              canDial={!!dialer?.ready && live && (session?.status === "ready" || session?.status === "paused")}
              liveMode={live}
              phoneReady={!!dialer?.ready}
              callStatus={callStatus}
              call={onThisCall ? session!.call : null}
              busy={busy}
              manualOpen={!!focus && focus.leadId === current.leadId && current.kind === "manual"}
              onDial={dial}
              onHangup={() => dialerAction("hangup")}
              onOutcome={logOutcome}
              onSkip={skip}
              onBack={backToList}
              onUpdate={update}
              flash={flash}
              now={now}
            />
          )}
        </div>
      </div>

      {toast && (
        <div role="status" className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 rounded-full bg-brand-900 text-white text-sm px-5 py-2.5 shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

function PhoneBar(props: {
  dialer: Dialer | null;
  phoneStatus: string;
  phoneError: string | null;
  muted: boolean;
  busy: boolean;
  onLive: () => void;
  onAuto: () => void;
  onPause: () => void;
  onHangup: () => void;
  onEnd: () => void;
  onMute: () => void;
  now: Date;
}) {
  const d = props.dialer;
  if (!d) return null;
  if (!d.ready) {
    return (
      <div className="card px-5 py-3 text-sm text-ink-muted">
        <b className="text-ink font-medium">Phone not set up yet.</b>{" "}
        {!d.setup.configured
          ? "Dial from your own phone and log each result here. Once phone setup is finished, calls go out from this page."
          : "This clinic has no Telnyx number yet. A super admin can add one on Phone setup."}
      </div>
    );
  }
  const s = d.session;
  const live = !!s && s.status !== "ended";
  const call = s?.call;
  const talking = call?.bridgedAt && !call.endedAt ? Math.max(0, Math.floor((props.now.getTime() - new Date(call.bridgedAt).getTime()) / 1000)) : 0;
  let label = "Offline";
  let tone = "badge-slate";
  if (live) {
    switch (s!.status) {
      case "connecting":
        label = "Connecting your browser phone…";
        tone = "badge-yellow";
        break;
      case "ready":
        label = s!.mode === "auto" ? "Auto-dial on · finding the next person" : "Live · ready to call";
        tone = "badge-green";
        break;
      case "dialing":
        label = `Dialing ${s!.lead?.name ?? ""}${call && call.dialNumber > 1 ? " (second dial)" : ""}…`;
        tone = "badge-yellow";
        break;
      case "connected":
        label = `On a call with ${s!.lead?.name ?? "a patient"} · ${Math.floor(talking / 60)}:${pad(talking % 60)}`;
        tone = "badge-indigo";
        break;
      case "wrapup":
        label = call && !call.bridgedAt ? `${HANGUP_LABEL[call.hangupCause ?? ""] ?? "Call ended"} · pick the result` : "Call ended · pick the result";
        tone = "badge-purple";
        break;
      case "paused":
        label = "Paused";
        tone = "badge-slate";
        break;
    }
  }
  return (
    <div className="card px-5 py-3 flex flex-wrap items-center gap-3">
      <span className={tone}>{label}</span>
      {s?.mode === "auto" && live && <span className="badge-indigo">Auto-dial</span>}
      <span className="flex-1" />
      {d.elsewhere && !live && <span className="text-xs text-ink-subtle">You&apos;re live on another clinic. Going live here ends that.</span>}
      {!live ? (
        <>
          <button className="btn-primary" disabled={props.busy || props.phoneStatus === "connecting"} onClick={props.onLive}>
            Go live
          </button>
          <button className="btn-secondary" disabled={props.busy || props.phoneStatus === "connecting"} onClick={props.onAuto}>
            Start auto-dial
          </button>
        </>
      ) : (
        <>
          {(s!.status === "dialing" || s!.status === "connected") && (
            <button className="btn-danger" onClick={props.onHangup}>
              Hang up
            </button>
          )}
          {s!.mode === "auto" ? (
            <button className="btn-secondary" onClick={props.onPause}>
              Pause auto-dial
            </button>
          ) : (
            <button className="btn-secondary" disabled={s!.status === "connecting"} onClick={props.onAuto}>
              Start auto-dial
            </button>
          )}
          <button className="btn-ghost" onClick={props.onMute} disabled={props.phoneStatus !== "live"}>
            {props.muted ? "Unmute" : "Mute"}
          </button>
          <button className="btn-ghost" onClick={props.onEnd}>
            End session
          </button>
        </>
      )}
      {(props.phoneError || s?.lastError) && (
        <div className="w-full text-sm text-amber-900 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
          {props.phoneError || s?.lastError}
        </div>
      )}
    </div>
  );
}

function itemSub(it: Item, l: Summary | undefined, rules: CallRulesConfig, tz: string): string {
  if (!l) return "";
  if (it.kind === "callback") return l.callbackAt ? formatDateTime(l.callbackAt, tz) : "Due today";
  if (it.kind === "confirm") return `${it.touch ? TOUCH_LABEL[it.touch] : "Confirm"} · ${formatDateTime(l.apptAt, tz)}`;
  if (it.kind === "resched") return `Try ${Math.min(l.attempts + 1, rules.rebookAttempts)} of ${rules.rebookAttempts}`;
  if (it.kind === "cycle") return `Try ${l.attempts + 1} of ${rules.maxAttempts}${l.lastAttemptDay ? ` · last ${formatDay(l.lastAttemptDay)}` : ""}`;
  return l.priority ? "Priority" : "New lead";
}

function Queue(props: {
  desk: Desk;
  current: Desk["current"];
  tz: string;
  onOpen: (id: string) => void;
  onMore: () => void;
  onRefresh: () => void;
}) {
  const { desk, current, tz } = props;
  const p = desk.plan;
  return (
    <aside className="card overflow-hidden lg:sticky lg:top-4" aria-label="Today's list">
      <div className="px-5 pt-4 pb-3 border-b border-line">
        <h2 className="text-sm font-semibold text-ink uppercase tracking-wider">Today&apos;s list</h2>
        <p className="text-xs text-ink-muted mt-1">
          {p.off
            ? p.offReason
            : `${formatDay(desk.day)} · ${p.total} people${desk.rules.freshDays.includes(dow(desk.day)) ? "" : " · no new leads today"}${
                p.held ? ` · ${p.held} more follow-ups go first next work day` : ""
              }`}
        </p>
      </div>
      <div className="max-h-[70vh] overflow-y-auto">
        {p.sections.length === 0 && !p.off && <p className="px-5 py-4 text-sm text-ink-muted">Nothing due today.</p>}
        {p.sections.map((sec) => (
          <details key={sec.kind} open={sec.kind !== "fresh" || sec.items.length <= 60 || current?.kind === "fresh"} className="border-b border-line last:border-b-0">
            <summary className="flex items-center gap-2 px-5 py-2.5 cursor-pointer text-xs font-semibold uppercase tracking-wider text-ink select-none">
              <span className={`h-2 w-2 rounded-sm ${SECTION_DOT[sec.kind]}`} />
              {KIND_LABEL[sec.kind].label}
              <span className="ml-auto tabular-nums text-ink-subtle font-normal">
                {sec.done}/{sec.total}
              </span>
            </summary>
            <ol>
              {sec.items.map((it) => {
                const l = desk.leads[it.leadId];
                const on = current?.leadId === it.leadId && !it.done;
                return (
                  <li key={`${it.leadId}:${it.kind}:${it.done}`}>
                    <button
                      onClick={() => props.onOpen(it.leadId)}
                      aria-current={on}
                      disabled={it.claimedByOther}
                      className={`w-full text-left px-5 py-2 text-sm border-l-2 transition-colors ${
                        on ? "border-brand-900 bg-surface-alt" : "border-transparent hover:bg-surface-base"
                      } ${it.done ? "text-ink-subtle line-through" : "text-ink"} ${it.claimedByOther ? "opacity-50 cursor-not-allowed" : ""}`}
                    >
                      <span className="flex justify-between gap-2">
                        <span className="truncate">{l?.name ?? "…"}</span>
                        <span className="tabular-nums text-xs text-ink-muted">{l ? formatPhone(l.phone).slice(-8) : ""}</span>
                      </span>
                      <span className="block text-xs text-ink-subtle no-underline">
                        {it.claimedByOther ? "Someone else has this one open" : itemSub(it, l, desk.rules, tz)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          </details>
        ))}
      </div>
      <div className="px-5 py-3 border-t border-line space-y-2">
        <p className="text-xs text-ink-subtle">{desk.newLeft.toLocaleString()} new leads not called yet.</p>
        <div className="flex gap-2">
          <button className="btn-secondary !py-1.5 text-xs" onClick={props.onMore} disabled={p.off}>
            Add 25 new leads
          </button>
          <button className="btn-ghost !py-1.5 text-xs" onClick={props.onRefresh}>
            Refresh
          </button>
        </div>
      </div>
    </aside>
  );
}

function Card(props: {
  desk: Desk;
  current: NonNullable<Desk["current"]>;
  detail: Detail;
  pos: number;
  total: number;
  tz: string;
  note: string;
  setNote: (v: string) => void;
  noteRef: React.MutableRefObject<HTMLTextAreaElement | null>;
  prompt: { outcome: CallOutcome; value: string; err?: string } | null;
  setPrompt: (p: { outcome: CallOutcome; value: string; err?: string } | null) => void;
  chips: [string, string][];
  redial: boolean;
  hoursOk: boolean;
  canDial: boolean;
  liveMode: boolean;
  phoneReady: boolean;
  callStatus: string | null;
  call: NonNullable<Dialer["session"]>["call"] | null;
  busy: boolean;
  manualOpen: boolean;
  onDial: () => void;
  onHangup: () => void;
  onOutcome: (o: CallOutcome, when?: string) => void;
  onSkip: () => void;
  onBack: () => void;
  onUpdate: (b: Record<string, unknown>) => void;
  flash: (m: string) => void;
  now: Date;
}) {
  const { current, detail: c, desk, tz } = props;
  const rules = desk.rules;
  const k = current.kind;
  const [stagePick, setStagePick] = useState<string>(c.stage);
  const [apptEdit, setApptEdit] = useState<string>(c.apptAt ? localInputValue(new Date(c.apptAt), tz) : "");
  useEffect(() => {
    setStagePick(c.stage);
    setApptEdit(c.apptAt ? localInputValue(new Date(c.apptAt), tz) : "");
  }, [c.id, c.stage, c.apptAt, tz]);

  let tag = KIND_LABEL[k].tag;
  if (k === "callback") tag += c.callbackAt ? ` · ${formatDateTime(c.callbackAt, tz)}` : " · due today";
  if (k === "confirm" && current.touch) tag += ` · ${TOUCH_LABEL[current.touch]}`;
  if (k === "cycle") tag += ` · try ${c.attempts + (props.redial ? 0 : 1)} of ${rules.maxAttempts}`;
  if (k === "resched") tag += ` · try ${c.attempts + (props.redial ? 0 : 1)} of ${rules.rebookAttempts}`;

  const stage = (isStage(c.stage) ? c.stage : "new") as Stage;
  const facts: [string, string][] = [
    ["Status", STAGE_LABEL[stage] + (stage === "lost" && c.lostReason ? ` (${c.lostReason})` : "")],
    ["No-answer tries", `${c.attempts} of ${stage === "resched" ? rules.rebookAttempts : rules.maxAttempts}`],
    ["Last called", c.lastCalledAt ? formatDateTime(c.lastCalledAt, tz) : "Never"],
    ["Calls in 24 hours", `${c.callsLast24h} of ${rules.maxCallsPer24h}`],
  ];
  if (c.apptAt && stage === "booked") facts.splice(1, 0, ["Appointment", formatDateTime(c.apptAt, tz)]);
  if (c.callbackAt && stage === "nurture") facts.splice(1, 0, ["Call back", formatDateTime(c.callbackAt, tz)]);

  const hints: { warn?: boolean; text: string }[] = [];
  if (props.redial) hints.push({ text: "It went straight to voicemail. Dial once more now, then pick the result of the second dial. Don't leave a message." });
  else if (k === "resched" && !(c.attempts > 0)) hints.push({ text: "Rebook call: you may leave one voicemail on this first try only." });
  else if (k === "confirm") hints.push({ text: `Confirmation call for ${formatDateTime(c.apptAt, tz)}. A voicemail is fine here.` });
  if (k !== "confirm" && !props.hoursOk) hints.push({ warn: true, text: `Outside calling hours (${hoursLabel(rules)}). Hold this call.` });
  if (c.callsLast24h >= rules.maxCallsPer24h) hints.push({ warn: true, text: `Already called ${c.callsLast24h} times in 24 hours. The limit is ${rules.maxCallsPer24h}.` });
  if (stage === "dnc") hints.push({ warn: true, text: "This person asked not to be called." });
  if (c.customer) hints.push({ text: `Already a patient here (${c.customer.name}).` });

  const set = outcomeSetFor(k);
  const inCall = props.callStatus === "dialing" || props.callStatus === "connected";
  const wrapup = props.callStatus === "wrapup";

  return (
    <section className="card-pad" aria-label="Current call">
      <div className="flex items-center gap-3">
        <span className="rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-amber-900">{tag}</span>
        {props.manualOpen && (
          <span className="text-xs text-ink-subtle">Opened from search</span>
        )}
        <span className="ml-auto text-xs text-ink-subtle tabular-nums">{props.pos ? `${props.pos} of ${props.total}` : ""}</span>
      </div>

      <h2 className="mt-4 text-3xl font-semibold tracking-tight text-ink flex items-center gap-3">
        {c.name}
        {c.priority && <span className="badge-yellow">Priority</span>}
      </h2>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <span className="text-3xl tabular-nums text-ink">{formatPhone(c.phone)}</span>
        <button
          className="btn-secondary"
          onClick={() => void navigator.clipboard?.writeText(formatPhone(c.phone)).then(() => props.flash("Number copied."))}
        >
          Copy number <kbd className="text-[10px] border border-line rounded px-1">C</kbd>
        </button>
        {props.phoneReady ? (
          inCall ? (
            <button className="btn-danger" onClick={props.onHangup}>
              {props.callStatus === "dialing" ? "Ringing… hang up" : "Hang up"}
            </button>
          ) : (
            <button
              className="btn-primary"
              onClick={props.onDial}
              disabled={!props.canDial || wrapup || stage === "dnc" || !props.hoursOk || c.callsLast24h >= rules.maxCallsPer24h}
              title={!props.liveMode ? "Go live first" : undefined}
            >
              {props.redial ? "Dial again" : "Call"}
            </button>
          )
        ) : (
          <a className="btn-ghost" href={`tel:+1${c.phone}`}>
            Call from this computer
          </a>
        )}
      </div>
      {props.phoneReady && !props.liveMode && <p className="text-xs text-ink-subtle mt-2">Go live (top of the page) to call from here.</p>}
      {props.call?.error && <p className="text-xs text-red-700 mt-2">{props.call.error}</p>}

      <dl className="mt-5 grid grid-cols-2 md:grid-cols-5 gap-4 border-y border-line py-4">
        {facts.map(([t, d]) => (
          <div key={t}>
            <dt className="text-[10px] uppercase tracking-wider text-ink-subtle">{t}</dt>
            <dd className="text-sm text-ink mt-0.5">{d}</dd>
          </div>
        ))}
      </dl>

      <div className="mt-4 rounded-lg border-l-4 border-amber-300 bg-surface-base px-4 py-3">
        <div className="text-[10px] uppercase tracking-wider text-ink-subtle">Last note</div>
        <div className="text-sm text-ink mt-0.5 whitespace-pre-wrap">{c.lastNote || <span className="text-ink-subtle">No notes yet.</span>}</div>
      </div>

      {hints.map((h, i) => (
        <div key={i} className={`mt-3 rounded-lg px-4 py-2.5 text-sm ${h.warn ? "bg-amber-50 text-amber-900 border border-amber-100" : "bg-sky-50 text-sky-900 border border-sky-100"}`}>
          {h.text}
        </div>
      ))}

      {wrapup && (
        <div className="mt-3 rounded-lg bg-purple-50 border border-purple-100 px-4 py-2.5 text-sm text-purple-900">
          {props.call && !props.call.bridgedAt
            ? `${HANGUP_LABEL[props.call.hangupCause ?? ""] ?? "The call ended"}. Pick what happened.`
            : "Call ended. Pick what happened."}
        </div>
      )}

      <label className="label mt-5" htmlFor="cc-note">
        Note for this call <span className="normal-case tracking-normal text-ink-subtle">(N to type, Alt + number to save with it)</span>
      </label>
      <textarea
        id="cc-note"
        ref={props.noteRef}
        rows={2}
        className="input"
        placeholder="What they said, best time to reach them"
        value={props.note}
        onChange={(e) => props.setNote(e.target.value)}
      />

      {props.prompt && (
        <div className="mt-3 rounded-xl border border-line bg-surface-base p-4" role="group">
          <label className="label" htmlFor="cc-when">
            {props.prompt.outcome === "cb" ? "When should you call back?" : props.prompt.outcome === "book" ? "Appointment date and time" : "New appointment date and time"}
          </label>
          <div className="flex flex-wrap gap-2 items-center">
            <input
              id="cc-when"
              type="datetime-local"
              step={300}
              className="input !w-auto"
              value={props.prompt.value}
              onChange={(e) => props.setPrompt({ ...props.prompt!, value: e.target.value, err: undefined })}
              autoFocus
            />
            <button
              className="btn-primary"
              disabled={props.busy}
              onClick={() => {
                if (!props.prompt!.value) return props.setPrompt({ ...props.prompt!, err: "Pick a date and time." });
                props.onOutcome(props.prompt!.outcome, props.prompt!.value);
              }}
            >
              Save
            </button>
            <button className="btn-ghost" onClick={() => props.setPrompt(null)}>
              Cancel
            </button>
          </div>
          {props.chips.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-3">
              {props.chips.map(([l, v]) => (
                <button key={l} className="btn-secondary !py-1 !px-3 text-xs" onClick={() => props.setPrompt({ ...props.prompt!, value: v })}>
                  {l}
                </button>
              ))}
            </div>
          )}
          <p className="text-xs text-ink-subtle mt-2">Clinic time ({tz.replace("America/", "").replace("_", " ")}).</p>
          {props.prompt.err && <p className="text-xs text-red-700 mt-1">{props.prompt.err}</p>}
        </div>
      )}

      <div className="mt-4 grid grid-cols-2 md:grid-cols-4 xl:grid-cols-5 gap-2">
        {set.map((b) => (
          <button
            key={b.outcome}
            disabled={props.busy || inCall}
            onClick={() => props.onOutcome(b.outcome)}
            className={`flex items-center justify-between gap-2 rounded-xl border px-4 py-3 text-sm font-medium text-left transition-colors disabled:opacity-50 ${TONE[b.tone]}`}
          >
            <span>{b.outcome === "vm" && props.redial ? "Still no answer" : b.label}</span>
            <kbd className="text-[10px] border border-current/30 rounded px-1 opacity-70">{b.key}</kbd>
          </button>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        {k !== "manual" && k !== "inbound" && (
          <button className="btn-ghost" onClick={props.onSkip} disabled={inCall}>
            Skip for now <kbd className="text-[10px] border border-line rounded px-1">S</kbd>
          </button>
        )}
        {(k === "manual" || k === "inbound" || props.manualOpen) && (
          <button className="btn-ghost" onClick={props.onBack}>
            Back to the list
          </button>
        )}
        <button className="btn-ghost" onClick={() => props.onOutcome("note")} disabled={props.busy}>
          Save note only
        </button>
      </div>

      <details className="mt-4 rounded-xl border border-line px-4 py-3">
        <summary className="text-sm font-medium text-ink cursor-pointer">Update without a call</summary>
        <div className="mt-3 space-y-3">
          {stage === "booked" && (
            <div className="flex flex-wrap items-center gap-2">
              <button className="btn-secondary !py-1.5 text-xs" onClick={() => props.onUpdate({ action: "mark", mark: "showed" })}>
                Showed
              </button>
              <button className="btn-secondary !py-1.5 text-xs" onClick={() => props.onUpdate({ action: "mark", mark: "cancelled" })}>
                Clinic says cancelled
              </button>
              <button className="btn-secondary !py-1.5 text-xs" onClick={() => props.onUpdate({ action: "mark", mark: "noshow" })}>
                Clinic says no-show
              </button>
              <input type="datetime-local" step={300} className="input !w-auto !py-1.5" value={apptEdit} onChange={(e) => setApptEdit(e.target.value)} aria-label="Appointment" />
              <button className="btn-secondary !py-1.5 text-xs" disabled={!apptEdit} onClick={() => props.onUpdate({ action: "appt", apptLocal: apptEdit })}>
                Save time
              </button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <select className="input !w-auto !py-1.5" value={stagePick} onChange={(e) => setStagePick(e.target.value)} aria-label="Status">
              {STAGES.map((st) => (
                <option key={st} value={st}>
                  {STAGE_LABEL[st]}
                </option>
              ))}
            </select>
            <button className="btn-secondary !py-1.5 text-xs" disabled={stagePick === c.stage} onClick={() => props.onUpdate({ action: "stage", stage: stagePick })}>
              Set status
            </button>
            <button className="btn-secondary !py-1.5 text-xs" onClick={() => props.onUpdate({ action: "priority", priority: !c.priority })}>
              {c.priority ? "Remove priority" : "Mark priority"}
            </button>
            {(stage === "lost" || stage === "dnq") && (
              <button className="btn-secondary !py-1.5 text-xs" onClick={() => props.onUpdate({ action: "mark", mark: "recycle" })}>
                Put back in rotation
              </button>
            )}
          </div>
          <p className="text-xs text-ink-subtle">
            Auto-dial consent: {c.consent ? "on file" : "none on file (call one at a time)"}
            {c.source ? ` · came from ${c.source.replace("_", " ")}` : ""}
            {c.sourceStatus ? ` · was "${c.sourceStatus}" in their list` : ""}
          </p>
        </div>
      </details>

      <details className="mt-3">
        <summary className="text-sm text-ink-muted cursor-pointer">History ({c.history.length})</summary>
        <ol className="mt-2 space-y-1.5">
          {c.history.length === 0 && <li className="text-sm text-ink-subtle">No calls yet.</li>}
          {c.history.map((h, i) => (
            <li key={i} className="grid grid-cols-[150px_1fr] gap-3 text-sm">
              <span className="text-ink-subtle tabular-nums">{formatDateTime(h.at, tz)}</span>
              <span className="text-ink">
                {OUTCOME_LABEL[h.outcome] ?? h.outcome}
                {h.touch && h.touch in TOUCH_LABEL ? ` (${TOUCH_LABEL[h.touch as Touch]})` : ""}
                {h.scheduledAt ? ` · ${formatDateTime(h.scheduledAt, tz)}` : ""}
                {h.note ? ` · ${h.note}` : ""}
              </span>
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
