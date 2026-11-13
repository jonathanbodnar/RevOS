"use client";

/**
 * The agent's browser phone (Telnyx WebRTC SDK, JWT login).
 *
 * Going live places ONE call that Telnyx parks and hands to RevOS (call parking
 * on the agents' credential connection); RevOS answers it and bridges each
 * lead onto it, so the agent stays on this one line for the whole session.
 * The SIP header carries the DialerSession id so the server can match them.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Call, INotification, TelnyxRTC } from "@telnyx/webrtc";

export type PhoneStatus = "off" | "connecting" | "live" | "error";

const ENDED = new Set(["hangup", "destroy", "destroyed", "purge"]);
const MIC_BLOCKED = "The browser blocked the microphone. Allow it for this site (the lock icon in the address bar), then go live again.";

export function useBrowserPhone(onDropped?: () => void) {
  const clientRef = useRef<TelnyxRTC | null>(null);
  const callRef = useRef<Call | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const droppedRef = useRef(onDropped);
  droppedRef.current = onDropped;
  const [status, setStatus] = useState<PhoneStatus>("off");
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);

  const stop = useCallback(() => {
    const call = callRef.current;
    const client = clientRef.current;
    callRef.current = null;
    clientRef.current = null;
    try {
      call?.hangup();
    } catch {
      /* already gone */
    }
    try {
      client?.disconnect();
    } catch {
      /* already gone */
    }
    setStatus("off");
    setMuted(false);
  }, []);

  const start = useCallback(
    async (opts: { token: string; dialTarget: string; header: string; sessionId: string }) => {
      stop();
      setError(null);
      setStatus("connecting");
      try {
        // Ask for the microphone up front so a refusal gets a clear message.
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());
      } catch {
        setStatus("error");
        setError(MIC_BLOCKED);
        return false;
      }
      const { TelnyxRTC: RTC } = await import("@telnyx/webrtc");
      const client = new RTC({ login_token: opts.token });
      clientRef.current = client;
      client.on("telnyx.ready", () => {
        if (clientRef.current !== client) return;
        callRef.current = client.newCall({
          destinationNumber: opts.dialTarget,
          callerNumber: opts.dialTarget,
          audio: true,
          video: false,
          customHeaders: [{ name: opts.header, value: opts.sessionId }],
          remoteElement: audioRef.current ?? undefined,
        });
      });
      client.on("telnyx.notification", (n: INotification) => {
        if (clientRef.current !== client) return;
        if (n.type === "userMediaError") {
          setStatus("error");
          setError(MIC_BLOCKED);
          return;
        }
        if (n.type !== "callUpdate" || !n.call) return;
        const state = String(n.call.state);
        if (state === "active") setStatus("live");
        if (ENDED.has(state) && callRef.current && n.call.id === callRef.current.id) {
          callRef.current = null;
          setStatus("off");
          droppedRef.current?.();
        }
      });
      client.on("telnyx.error", () => {
        if (clientRef.current !== client) return;
        setStatus("error");
        setError("The browser phone couldn't connect. Check your internet connection and go live again.");
      });
      client.connect();
      return true;
    },
    [stop],
  );

  const toggleMute = useCallback(() => {
    const c = callRef.current;
    if (!c) return;
    if (muted) c.unmuteAudio();
    else c.muteAudio();
    setMuted(!muted);
  }, [muted]);

  useEffect(() => () => stop(), [stop]);

  return { status, error, muted, start, stop, toggleMute, audioRef };
}
