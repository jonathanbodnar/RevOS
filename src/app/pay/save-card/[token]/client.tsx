"use client";

import { useEffect, useRef, useState } from "react";

export function SaveCardClient({ token }: { token: string }) {
  const [status, setStatus] = useState<
    "loading" | "ready" | "saving" | "done" | "error" | "sdk-missing"
  >("loading");
  const [error, setError] = useState<string | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/public/save-card/${token}/intention`, {
          method: "POST",
        });
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(d.error || "Could not initialize form");
        }
        const intention = (await res.json()) as { clientToken: string };

        await loadScript(
          process.env.NEXT_PUBLIC_FORTIS_ELEMENTS_URL ||
            "https://js.fortis.tech/commercejs-v1.0.0.min.js",
        );
        if (cancelled) return;

        const Commerce = window.Commerce;
        if (!Commerce?.elements) {
          setStatus("sdk-missing");
          return;
        }
        const elements = new Commerce.elements(intention.clientToken, {
          appearance: { theme: "light" },
        });
        const card = elements.create("payment", { fields: ["card"] });
        if (mountRef.current) card.mount(mountRef.current);
        card.on("done", async (payload: unknown) => {
          const p = (payload ?? {}) as Record<string, unknown>;
          const ticketId =
            (p.ticket_id as string) ||
            (p.ticketId as string) ||
            (p.token as string);
          const paymentMethod = (p.payment_method as "cc" | "ach") || "cc";
          if (!ticketId) {
            setStatus("error");
            setError("No ticket returned.");
            return;
          }
          setStatus("saving");
          const saveRes = await fetch(`/api/public/save-card/${token}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ticketId, paymentMethod }),
          });
          if (!saveRes.ok) {
            const d = (await saveRes.json().catch(() => ({}))) as {
              error?: string;
            };
            setStatus("error");
            setError(d.error || "Failed to save card.");
            return;
          }
          setStatus("done");
        });
        card.on("error", (payload: unknown) => {
          const p = (payload ?? {}) as { message?: string };
          setStatus("error");
          setError(p.message || "Card entry failed.");
        });
        setStatus("ready");
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : "Error";
        if (msg === "load failed") setStatus("sdk-missing");
        else {
          setStatus("error");
          setError(msg);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (status === "done") {
    return (
      <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-md p-3 text-center">
        Payment method saved. You can close this window.
      </div>
    );
  }
  if (status === "sdk-missing") {
    return (
      <div className="text-sm text-amber-800 bg-amber-50 border border-amber-100 rounded-md p-3">
        The secure payment form couldn't load. Please contact the clinic.
      </div>
    );
  }
  return (
    <div>
      {status === "loading" && (
        <div className="text-sm text-slate-500 py-8 text-center">
          Loading secure form…
        </div>
      )}
      <div
        ref={mountRef}
        className="rounded-md border border-slate-200 bg-slate-50 min-h-[200px] p-3"
      />
      {status === "saving" && (
        <p className="text-xs text-slate-500 mt-3 text-center">Saving…</p>
      )}
      {status === "error" && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-100 rounded-md p-3 mt-3">
          {error}
        </div>
      )}
    </div>
  );
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(
      `script[data-src="${src}"]`,
    ) as HTMLScriptElement | null;
    if (existing) {
      if (existing.dataset.loaded === "1") return resolve();
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("load failed")));
      return;
    }
    const s = document.createElement("script");
    s.src = src;
    s.async = true;
    s.dataset.src = src;
    s.addEventListener("load", () => {
      s.dataset.loaded = "1";
      resolve();
    });
    s.addEventListener("error", () => reject(new Error("load failed")));
    document.head.appendChild(s);
  });
}
