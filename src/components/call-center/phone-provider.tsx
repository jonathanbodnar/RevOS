"use client";

/**
 * The agent's phone line for one clinic, held in the clinic layout so it
 * survives switching between Today / Leads / Report / Import / Call rules.
 * (Leaving the clinic, or switching clinics, ends it: one clinic at a time.)
 */
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useBrowserPhone, type PhoneStatus } from "./use-browser-phone";

export type DialerState = {
  ready: boolean;
  setup: { configured: boolean; apiKey: boolean; webhookKey: boolean };
  numbers: { e164: string; isDefault: boolean }[];
  sessionHeader: string;
  elsewhere: { clinicId: string } | null;
  session: {
    id: string;
    mode: "manual" | "auto";
    status: string;
    lastError: string | null;
    call: {
      id: string;
      status: string;
      direction: string;
      dialNumber: number;
      kind: string | null;
      startedAt: string;
      bridgedAt: string | null;
      endedAt: string | null;
      hangupCause: string | null;
      amdResult: string | null;
      error: string | null;
    } | null;
    lead: { id: string; name: string; phone: string } | null;
  } | null;
};

type Ctx = {
  dialer: DialerState | null;
  live: boolean;
  phoneStatus: PhoneStatus;
  phoneError: string | null;
  muted: boolean;
  busy: boolean;
  refresh: () => Promise<void>;
  goLive: (mode: "manual" | "auto") => Promise<string | null>;
  endLive: () => Promise<void>;
  action: (a: "auto" | "pause" | "hangup") => Promise<string | null>;
  toggleMute: () => void;
};

const PhoneCtx = createContext<Ctx | null>(null);

export function usePhone(): Ctx {
  const c = useContext(PhoneCtx);
  if (!c) throw new Error("usePhone must be used inside PhoneProvider");
  return c;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: { "Content-Type": "application/json" }, cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as { data?: T; error?: string };
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body.data as T;
}

export function PhoneProvider({ clinicId, children }: { clinicId: string; children: React.ReactNode }) {
  const base = `/api/call-center/${clinicId}/dialer`;
  const [dialer, setDialer] = useState<DialerState | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setDialer(await api<DialerState>(base));
    } catch {
      /* keep the last state; the next poll retries */
    }
  }, [base]);

  const phone = useBrowserPhone(() => void refresh());
  const live = !!dialer?.session && dialer.session.status !== "ended";

  useEffect(() => {
    void refresh();
  }, [refresh]);
  // Fast while live (it's also the heartbeat that keeps auto-dial going), slow otherwise.
  useEffect(() => {
    const t = window.setInterval(() => void refresh(), live ? 1500 : 15000);
    return () => window.clearInterval(t);
  }, [live, refresh]);

  // Leaving the clinic ends the session on the server too.
  useEffect(() => {
    return () => {
      void fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "end" }), keepalive: true }).catch(() => {});
    };
  }, [base]);

  const goLive = useCallback(
    async (mode: "manual" | "auto") => {
      setBusy(true);
      try {
        const s = await api<{ sessionId: string; dialTarget: string; header: string }>(base, {
          method: "POST",
          body: JSON.stringify({ action: "start", mode }),
        });
        const { token } = await api<{ token: string }>(`/api/call-center/phone/token`, { method: "POST" });
        const ok = await phone.start({ token, dialTarget: s.dialTarget, header: s.header, sessionId: s.sessionId });
        if (!ok) await api(base, { method: "POST", body: JSON.stringify({ action: "end" }) }).catch(() => {});
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : "Couldn't go live.";
      } finally {
        setBusy(false);
        void refresh();
      }
    },
    [base, phone, refresh],
  );

  const endLive = useCallback(async () => {
    await api(base, { method: "POST", body: JSON.stringify({ action: "end" }) }).catch(() => {});
    phone.stop();
    void refresh();
  }, [base, phone, refresh]);

  const action = useCallback(
    async (a: "auto" | "pause" | "hangup") => {
      try {
        if (a === "auto" && !live) return await goLive("auto");
        await api(base, { method: "POST", body: JSON.stringify({ action: a }) });
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : "That didn't work.";
      } finally {
        void refresh();
      }
    },
    [base, live, goLive, refresh],
  );

  return (
    <PhoneCtx.Provider
      value={{
        dialer,
        live,
        phoneStatus: phone.status,
        phoneError: phone.error,
        muted: phone.muted,
        busy,
        refresh,
        goLive,
        endLive,
        action,
        toggleMute: phone.toggleMute,
      }}
    >
      <audio ref={phone.audioRef} autoPlay className="hidden" />
      {children}
    </PhoneCtx.Provider>
  );
}

/** Small status chip for the clinic tabs. */
export function PhoneChip() {
  const { dialer, live } = usePhone();
  if (!live || !dialer?.session) return null;
  const s = dialer.session;
  const label =
    s.status === "connected" ? "On a call" : s.status === "dialing" ? "Dialing" : s.status === "wrapup" ? "Log the result" : s.mode === "auto" ? "Auto-dial" : "Live";
  return <span className={s.status === "connected" ? "badge-indigo" : "badge-green"}>● {label}</span>;
}
