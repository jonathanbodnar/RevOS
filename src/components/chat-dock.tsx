"use client";

import Link from "next/link";
import { useState } from "react";
import { Icon } from "./icon";

type Source = { id: string; title: string };
type Msg = {
  role: "user" | "assistant";
  text: string;
  sources?: Source[];
};

/**
 * Bottom-right internal assistant. Two modes: "Training" (searches published
 * modules) and "Data" (aggregate, non-PHI clinic stats). It never surfaces
 * individual patient details.
 */
export function ChatDock() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"elearning" | "data">("elearning");
  const [input, setInput] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const question = input.trim();
    if (!question || busy) return;
    setInput("");
    setMsgs((m) => [...m, { role: "user", text: question }]);
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, mode }),
      });
      const d = (await res.json().catch(() => ({}))) as {
        data?: { answer: string; sources?: Source[] };
        error?: string;
      };
      setMsgs((m) => [
        ...m,
        {
          role: "assistant",
          text: d.data?.answer || d.error || "Something went wrong.",
          sources: d.data?.sources,
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        className="fixed bottom-5 right-5 z-40 h-12 w-12 rounded-full bg-brand-600 text-white shadow-lg hover:bg-brand-700 flex items-center justify-center"
        aria-label="Open assistant"
      >
        <Icon name={open ? "chevron-right" : "message"} className="h-5 w-5" />
      </button>

      {open && (
        <div className="fixed bottom-20 right-5 z-40 w-[22rem] max-w-[calc(100vw-2.5rem)] card overflow-hidden flex flex-col shadow-xl">
          <div className="px-4 py-3 border-b border-line flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-900">Assistant</div>
            <div className="flex gap-1 text-xs">
              <button
                onClick={() => setMode("elearning")}
                className={
                  mode === "elearning"
                    ? "px-2 py-0.5 rounded bg-brand-600 text-white"
                    : "px-2 py-0.5 rounded text-slate-500 hover:bg-slate-100"
                }
              >
                Training
              </button>
              <button
                onClick={() => setMode("data")}
                className={
                  mode === "data"
                    ? "px-2 py-0.5 rounded bg-brand-600 text-white"
                    : "px-2 py-0.5 rounded text-slate-500 hover:bg-slate-100"
                }
              >
                Data
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto max-h-80 px-4 py-3 space-y-3 text-sm">
            {msgs.length === 0 && (
              <p className="text-slate-400 text-xs">
                {mode === "elearning"
                  ? "Ask about a process or training topic."
                  : "Ask an aggregate question, e.g. “how many active patients”."}
              </p>
            )}
            {msgs.map((m, i) => (
              <div
                key={i}
                className={m.role === "user" ? "text-right" : "text-left"}
              >
                <div
                  className={
                    m.role === "user"
                      ? "inline-block bg-brand-600 text-white rounded-lg px-3 py-1.5"
                      : "inline-block bg-slate-100 text-slate-800 rounded-lg px-3 py-1.5"
                  }
                >
                  {m.text}
                </div>
                {m.sources && m.sources.length > 0 && (
                  <div className="mt-1 space-x-2">
                    {m.sources.map((s) => (
                      <Link
                        key={s.id}
                        href={`/clinic/learn/${s.id}`}
                        className="text-xs text-brand-600 hover:underline"
                      >
                        {s.title}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {busy && <p className="text-slate-400 text-xs">Thinking…</p>}
          </div>

          <form onSubmit={send} className="border-t border-line p-2 flex gap-2">
            <input
              className="input flex-1 text-sm"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask a question…"
            />
            <button type="submit" className="btn-primary text-sm" disabled={busy}>
              Send
            </button>
          </form>
        </div>
      )}
    </>
  );
}
